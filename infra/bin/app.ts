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
// Ops alarm address. Kept out of committed source (this is a public repo): supply
// it via the ALERT_EMAIL env var at deploy time (CI sets it from a repo variable).
// Falls back to cdk context for anyone who prefers a gitignored cdk.context.json.
// When unset, backend-stack simply skips the SNS email subscription.
const alertEmail =
  process.env.ALERT_EMAIL ?? (app.node.tryGetContext('alertEmail') as string | undefined);

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
    alertEmail,
    deepLinkBaseUrl: `https://${web.distribution.distributionDomainName}`,
  });
}
