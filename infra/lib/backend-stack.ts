import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(__dirname, '..', '..', 'backend');

export interface BackendStackProps extends StackProps {
  stage: 'staging' | 'prod';
  /** CloudFront domain of the web stack — deep links in calendar descriptions. */
  deepLinkBaseUrl: string;
  googleClientId: string;
  /** Email for operational alerts; subscription is skipped for placeholder values. */
  alertEmail?: string;
}

export class BackendStack extends Stack {
  readonly apiUrl: CfnOutput;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const isProd = stage === 'prod';

    // ---- Data stores -----------------------------------------------------

    const table = new dynamodb.Table(this, 'MainTable', {
      tableName: `s2c-main-${stage}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      // Only items that carry `expiresAt` age out (currently AICALL# telemetry,
      // 90 days). Captures/corrections omit the attribute and are never expired.
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const imagesBucket = new s3.Bucket(this, 'ImagesBucket', {
      bucketName: `s2c-images-${this.account}-${stage}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { prefix: 'exports/', expiration: Duration.days(7) },
        {
          prefix: 'users/',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const dlq = new sqs.Queue(this, 'ProcessDlq', {
      queueName: `s2c-process-dlq-${stage}`,
      retentionPeriod: Duration.days(14),
    });
    const queue = new sqs.Queue(this, 'ProcessQueue', {
      queueName: `s2c-process-${stage}`,
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ---- Lambdas ---------------------------------------------------------

    const commonEnv: Record<string, string> = {
      STAGE: stage,
      TABLE_NAME: table.tableName,
      BUCKET_NAME: imagesBucket.bucketName,
      QUEUE_URL: queue.queueUrl,
      DEEPLINK_BASE_URL: props.deepLinkBaseUrl,
      GOOGLE_CLIENT_ID: props.googleClientId,
      POWERTOOLS_SERVICE_NAME: `s2c-${stage}`,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const ssmParamsPolicy = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/s2c/${stage}/*`,
      ],
    });

    const makeFn = (
      name: string,
      entryFile: string,
      handlerExport: string,
      opts: { memory?: number; timeout?: number; copyPrompts?: boolean } = {},
    ): NodejsFunction => {
      const fn = new NodejsFunction(this, name, {
        functionName: `s2c-${name.toLowerCase()}-${stage}`,
        entry: path.join(backendDir, 'src', 'handlers', entryFile),
        handler: handlerExport,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: opts.memory ?? 512,
        timeout: Duration.seconds(opts.timeout ?? 15),
        environment: commonEnv,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/s2c-${name.toLowerCase()}-${stage}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        depsLockFilePath: path.join(backendDir, 'package-lock.json'),
        projectRoot: backendDir,
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          sourceMap: true,
          mainFields: ['module', 'main'],
          // ESM bundles still pull CJS deps that call require():
          banner:
            "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
          ...(opts.copyPrompts
            ? {
                commandHooks: {
                  beforeBundling: () => [],
                  beforeInstall: () => [],
                  // Versioned prompt .md files are read at runtime relative to
                  // the bundled entry file — ship them next to it.
                  afterBundling: (inputDir: string, outputDir: string) => [
                    `cp ${inputDir}/src/prompts/*.md ${outputDir}/`,
                  ],
                },
              }
            : {}),
        },
      });
      table.grantReadWriteData(fn);
      fn.addToRolePolicy(ssmParamsPolicy);
      return fn;
    };

    const processor = makeFn('Processor', 'process-capture.ts', 'handler', {
      memory: 1024,
      timeout: 120,
      copyPrompts: true,
    });
    imagesBucket.grantRead(processor);
    processor.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    const authFn = makeFn('AuthGoogle', 'auth-google.ts', 'handler');
    const capturesCreateFn = makeFn('CapturesCreate', 'captures-create.ts', 'handler', {
      memory: 1024, // base64 decode + S3 put of image payloads
      timeout: 30,
    });
    imagesBucket.grantPut(capturesCreateFn);
    queue.grantSendMessages(capturesCreateFn);

    const capturesListFn = makeFn('CapturesList', 'captures-read.ts', 'listHandler');
    const capturesGetFn = makeFn('CapturesGet', 'captures-read.ts', 'getHandler');
    const captureImageUrlFn = makeFn('CaptureImageUrl', 'captures-read.ts', 'imageUrlHandler');
    imagesBucket.grantRead(captureImageUrlFn);

    const capturesUpdateFn = makeFn('CapturesUpdate', 'captures-update.ts', 'handler', {
      timeout: 30,
    });
    const capturesApproveFn = makeFn('CapturesApprove', 'captures-approve.ts', 'handler', {
      timeout: 30,
    });
    const capturesDeleteFn = makeFn('CapturesDelete', 'captures-delete.ts', 'handler', {
      timeout: 30,
    });
    imagesBucket.grantDelete(capturesDeleteFn);

    const calendarsListFn = makeFn('CalendarsList', 'calendars.ts', 'listHandler', {
      timeout: 30,
    });
    const calendarsCreateFn = makeFn('CalendarsCreate', 'calendars.ts', 'createHandler', {
      timeout: 30,
    });
    const settingsGetFn = makeFn('SettingsGet', 'settings.ts', 'getHandler');
    const settingsPutFn = makeFn('SettingsPut', 'settings.ts', 'putHandler');

    const accountExportFn = makeFn('AccountExport', 'account.ts', 'exportHandler', {
      timeout: 60,
    });
    imagesBucket.grantReadWrite(accountExportFn);
    const accountDeleteFn = makeFn('AccountDelete', 'account.ts', 'deleteHandler', {
      timeout: 120,
    });
    imagesBucket.grantReadWrite(accountDeleteFn);

    const healthFn = makeFn('Health', 'health.ts', 'handler', { memory: 128 });

    // ---- HTTP API --------------------------------------------------------

    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `s2c-api-${stage}`,
    });

    const route = (
      method: apigwv2.HttpMethod,
      routePath: string,
      fn: NodejsFunction,
    ): void => {
      api.addRoutes({
        path: routePath,
        methods: [method],
        integration: new HttpLambdaIntegration(`${fn.node.id}Int`, fn),
      });
    };

    route(apigwv2.HttpMethod.POST, '/v1/auth/google', authFn);
    route(apigwv2.HttpMethod.POST, '/v1/captures', capturesCreateFn);
    route(apigwv2.HttpMethod.GET, '/v1/captures', capturesListFn);
    route(apigwv2.HttpMethod.GET, '/v1/captures/{id}', capturesGetFn);
    route(apigwv2.HttpMethod.GET, '/v1/captures/{id}/image', captureImageUrlFn);
    route(apigwv2.HttpMethod.PATCH, '/v1/captures/{id}', capturesUpdateFn);
    route(apigwv2.HttpMethod.POST, '/v1/captures/{id}/approve', capturesApproveFn);
    route(apigwv2.HttpMethod.DELETE, '/v1/captures/{id}', capturesDeleteFn);
    route(apigwv2.HttpMethod.GET, '/v1/calendars', calendarsListFn);
    route(apigwv2.HttpMethod.POST, '/v1/calendars', calendarsCreateFn);
    route(apigwv2.HttpMethod.GET, '/v1/settings', settingsGetFn);
    route(apigwv2.HttpMethod.PUT, '/v1/settings', settingsPutFn);
    route(apigwv2.HttpMethod.POST, '/v1/account/export', accountExportFn);
    route(apigwv2.HttpMethod.DELETE, '/v1/account', accountDeleteFn);
    route(apigwv2.HttpMethod.GET, '/v1/health', healthFn);

    // ---- Observability ---------------------------------------------------

    // Alarms are useless if nobody hears them: everything notifies this topic.
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `s2c-alerts-${stage}`,
    });
    if (props.alertEmail && !props.alertEmail.startsWith('REPLACE_ME')) {
      alertsTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.alertEmail),
      );
    }
    const notify = new cloudwatchActions.SnsAction(alertsTopic);

    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: `s2c-dlq-not-empty-${stage}`,
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A capture failed processing 3 times and landed on the DLQ.',
    });
    dlqAlarm.addAlarmAction(notify);

    for (const [name, fn] of [
      ['Processor', processor],
      ['AuthGoogle', authFn],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `s2c-${name.toLowerCase()}-errors-${stage}`,
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda reported errors.`,
      });
      alarm.addAlarmAction(notify);
    }

    // Daily AI spend guardrail — the metric is emitted by lib/anthropic.ts
    // (EMF via powertools) on every Claude call. A runaway processing loop
    // trips this within a day instead of showing up on the invoice.
    const aiSpendAlarm = new cloudwatch.Alarm(this, 'AiSpendAlarm', {
      alarmName: `s2c-ai-spend-${stage}`,
      metric: new cloudwatch.Metric({
        namespace: 's2c',
        metricName: 'AiCostUsd',
        dimensionsMap: { stage },
        statistic: 'Sum',
        period: Duration.hours(24),
      }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Anthropic spend exceeded $2 in 24h — check for a processing loop.',
    });
    aiSpendAlarm.addAlarmAction(notify);

    this.apiUrl = new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
