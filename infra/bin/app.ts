import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/backend-stack.js';
import { WebStack } from '../lib/web-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-2',
};

const googleClientId = app.node.tryGetContext('googleClientId') as string;
const appleTeamId = app.node.tryGetContext('appleTeamId') as string;
const iosBundleId = app.node.tryGetContext('iosBundleId') as string;

for (const stage of ['staging', 'prod'] as const) {
  const web = new WebStack(app, `S2cWeb-${stage}`, {
    stage,
    env,
    appleTeamId,
    iosBundleId,
  });
  new BackendStack(app, `S2cBackend-${stage}`, {
    stage,
    env,
    googleClientId,
    deepLinkBaseUrl: `https://${web.distribution.distributionDomainName}`,
  });
}
