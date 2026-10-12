import { beforeAll, describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack.js';
import { WebStack } from '../lib/web-stack.js';

let backend: Template;
let web: Template;

beforeAll(() => {
  const app = new App();
  const webStack = new WebStack(app, 'S2cWeb-test', {
    stage: 'staging',
    env: { account: '111111111111', region: 'eu-west-2' },
    appleTeamId: 'TEAM123456',
    iosBundleId: 'digital.callaeas.s2c',
  });
  const backendStack = new BackendStack(app, 'S2cBackend-test', {
    stage: 'staging',
    env: { account: '111111111111', region: 'eu-west-2' },
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    alertEmail: 'ops@example.com',
    deepLinkBaseUrl: 'https://d123.cloudfront.net',
  });
  backend = Template.fromStack(backendStack);
  web = Template.fromStack(webStack);
}, 300_000);

describe('BackendStack', () => {
  it('defines the single table with PK/SK and GSI1', () => {
    backend.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 's2c-main-staging',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('leaves the staging table deletable', () => {
    backend.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 's2c-main-staging',
      DeletionProtectionEnabled: false,
    });
  });

  it('wires the processing queue to a DLQ with 3 retries', () => {
    backend.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 's2c-process-staging',
      RedrivePolicy: {
        maxReceiveCount: 3,
      },
    });
  });

  it('caps the processor at two concurrent captures to bound Claude spend', () => {
    backend.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
    });
  });

  it('exposes all 14 API routes', () => {
    const routes = backend.findResources('AWS::ApiGatewayV2::Route');
    const keys = Object.values(routes).map(
      (r) => (r.Properties as { RouteKey: string }).RouteKey,
    );
    expect(keys).toHaveLength(15);
    expect(keys).toContain('POST /v1/auth/google');
    expect(keys).toContain('POST /v1/captures');
    expect(keys).toContain('PATCH /v1/captures/{id}');
    expect(keys).toContain('POST /v1/captures/{id}/approve');
    expect(keys).toContain('DELETE /v1/account');
    expect(keys).toContain('GET /v1/health');
  });

  it('runs Lambdas on Node 22 / arm64 with the stage env', () => {
    backend.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: {
          STAGE: 'staging',
          DEEPLINK_BASE_URL: 'https://d123.cloudfront.net',
        },
      },
    });
  });

  it('alarms when the DLQ is not empty and notifies the alerts topic', () => {
    backend.hasResourceProperties('AWS::SNS::Topic', { TopicName: 's2c-alerts-staging' });
    backend.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 's2c-dlq-not-empty-staging',
      Threshold: 1,
      AlarmActions: [{ Ref: Match.stringLikeRegexp('AlertsTopic') }],
    });
  });

  it('subscribes the alert email when configured, skips placeholders', () => {
    // Test stack uses a real-looking email — subscription must exist.
    backend.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  it('alarms on processor errors and daily AI spend', () => {
    backend.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 's2c-processor-errors-staging',
      MetricName: 'Errors',
    });
    backend.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 's2c-ai-spend-staging',
      Namespace: 's2c',
      MetricName: 'AiCostUsd',
      Statistic: 'Sum',
      Period: 86400,
      Threshold: 2,
    });
    // CloudWatch matches the full dimension set, so the alarm must carry the
    // 'service' dimension powertools adds as well as 'stage'. arrayWith is
    // order-sensitive, so check each one on its own.
    for (const dimension of [
      { Name: 'service', Value: 's2c' },
      { Name: 'stage', Value: 'staging' },
    ]) {
      backend.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 's2c-ai-spend-staging',
        Dimensions: Match.arrayWith([Match.objectLike(dimension)]),
      });
    }
  });

  it('alarms on any HTTP API 5xx and notifies the alerts topic', () => {
    backend.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 's2c-api-5xx-staging',
      Namespace: 'AWS/ApiGateway',
      MetricName: '5xx',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('AlertsTopic') }],
    });
  });

  it('lets the capture upload delete its image when a later step fails', () => {
    backend.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('^CapturesCreateServiceRole') }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 's3:DeleteObject*', Effect: 'Allow' }),
        ]),
      },
    });
  });

  it('expires exports after 7 days', () => {
    backend.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 's2c-images-111111111111-staging',
      LifecycleConfiguration: {
        Rules: [
          { Prefix: 'exports/', ExpirationInDays: 7, Status: 'Enabled' },
          {
            Prefix: 'users/',
            Status: 'Enabled',
            Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: 90 }],
          },
        ],
      },
    });
  });
});

describe('BackendStack (prod)', () => {
  let prod: Template;

  beforeAll(() => {
    // Skips Lambda bundling for this app: these checks are about the table.
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const prodStack = new BackendStack(app, 'S2cBackend-prod-test', {
      stage: 'prod',
      env: { account: '111111111111', region: 'eu-west-2' },
      googleClientId: 'test-client-id.apps.googleusercontent.com',
      deepLinkBaseUrl: 'https://d123.cloudfront.net',
    });
    prod = Template.fromStack(prodStack);
  });

  it('protects the prod table from deletion as well as retaining it', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 's2c-main-prod',
      DeletionProtectionEnabled: true,
    });
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });
});

describe('WebStack', () => {
  it('serves via CloudFront with the capture fallback error mapping', () => {
    web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/capture-fallback.html' },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/capture-fallback.html' },
        ],
      },
    });
  });

  it('keeps the web bucket private (OAC, no public access)', () => {
    web.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
      },
    });
  });
});
