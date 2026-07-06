// Static web presence on the default CloudFront domain (no custom domain
// needed): the apple-app-site-association file that makes universal links
// work, the /c/{captureId} fallback page for links opened without the app,
// and the privacy policy / terms pages linked from the app.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebStackProps extends StackProps {
  stage: 'staging' | 'prod';
  appleTeamId: string;
  iosBundleId: string;
}

export class WebStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const isProd = stage === 'prod';

    const bucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `s2c-web-${this.account}-${stage}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      // /c/{captureId} has no object in the bucket — serve the "open in the
      // app" fallback. (OAC-denied missing keys surface as 403.)
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/capture-fallback.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/capture-fallback.html',
        },
      ],
    });

    new s3deploy.BucketDeployment(this, 'WebAssets', {
      destinationBucket: bucket,
      distribution: this.distribution,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'web-assets')),
        // The AASA file must be served from /.well-known/ as JSON. Apple
        // requires the appID to match TEAMID.BUNDLEID exactly.
        s3deploy.Source.jsonData('.well-known/apple-app-site-association', {
          applinks: {
            apps: [],
            details: [
              {
                appIDs: [`${props.appleTeamId}.${props.iosBundleId}`],
                components: [{ '/': '/c/*', comment: 'Capture deep links' }],
              },
            ],
          },
        }),
      ],
    });

    new CfnOutput(this, 'WebDomain', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
