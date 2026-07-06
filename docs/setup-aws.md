# AWS setup

One-time setup from zero to a deployed backend. Everything runs in
**eu-west-2** (London) so data stays in the UK/EU.

## 1. Account and CLI

1. Create an AWS account (or use an existing one). Enable MFA on the root
   user, then create an IAM user or (better) an IAM Identity Center user with
   `AdministratorAccess` for bootstrap.
2. Install the AWS CLI and configure credentials:
   ```bash
   aws configure   # or: aws configure sso
   aws sts get-caller-identity   # sanity check — note the account id
   ```

## 2. CDK bootstrap

```bash
cd infra && npm ci
npx cdk bootstrap aws://<ACCOUNT_ID>/eu-west-2
```

## 3. Secrets (SSM Parameter Store)

Create the five SecureStrings per stage. Generate the two random keys locally:

```bash
STAGE=staging   # repeat for prod
aws ssm put-parameter --region eu-west-2 --type SecureString \
  --name /s2c/$STAGE/anthropic-api-key --value 'sk-ant-...'
aws ssm put-parameter --region eu-west-2 --type SecureString \
  --name /s2c/$STAGE/google-oauth-client-secret --value '<web client secret — see setup-google.md>'
aws ssm put-parameter --region eu-west-2 --type SecureString \
  --name /s2c/$STAGE/places-api-key --value '<places API key — see setup-google.md>'
aws ssm put-parameter --region eu-west-2 --type SecureString \
  --name /s2c/$STAGE/jwt-secret --value "$(openssl rand -hex 32)"
aws ssm put-parameter --region eu-west-2 --type SecureString \
  --name /s2c/$STAGE/token-enc-key --value "$(openssl rand -hex 32)"
```

> `token-enc-key` encrypts Google refresh tokens (AES-256-GCM). Losing it
> means users must sign in again; leaking it plus a DB dump exposes tokens —
> treat it like a password.

## 4. Configure context

Edit `infra/cdk.json` context values:

- `googleClientId` — the **web** OAuth client id (setup-google.md step 3)
- `appleTeamId` — your Apple Developer Team ID (setup-apple.md)
- `iosBundleId` — keep `com.rhysdunne.s2c` or change it consistently with
  `ios/project.yml`
- `alertEmail` — where operational alarms go (DLQ, Lambda errors, daily AI
  spend > $2). After the first deploy, **confirm the SNS subscription email**
  AWS sends you, or the alarms notify no one.

## 5. Deploy

```bash
cd infra
npx cdk deploy S2cWeb-staging S2cBackend-staging
npx cdk deploy S2cWeb-prod S2cBackend-prod
```

Note the outputs:

- `S2cWeb-*.WebDomain` → the CloudFront domain. Paste (without scheme) into
  `ios/project.yml` (Associated Domains) and `ios/Shared/AppConfig.swift`.
- `S2cBackend-*.ApiUrl` → paste into `ios/Shared/AppConfig.swift`.

Verify:

```bash
curl "<ApiUrl>/v1/health"                     # {"status":"ok","stage":"..."}
curl "https://<WebDomain>/.well-known/apple-app-site-association"
```

## 6. GitHub Actions deploys (optional but recommended)

`deploy.yml` uses GitHub OIDC — no long-lived AWS keys in GitHub.

1. Create the OIDC identity provider + role (one-off):
   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```
2. Create a role `s2c-github-deploy` trusting
   `repo:<owner>/<repo>:ref:refs/heads/main` with a policy allowing
   CloudFormation/CDK deploys (start with `AdministratorAccess`, tighten
   later), and set its ARN as the repo secret/variable `AWS_DEPLOY_ROLE_ARN`.
3. Run the **Deploy** workflow from the Actions tab, choosing the stage.

## Costs

Personal-scale usage sits inside the always-free tiers of Lambda, DynamoDB
on-demand, and SQS. Real money: S3/CloudFront (pennies), CloudWatch logs
(30-day retention configured), Anthropic API (~$0.01/capture). Expect
≲ $2/month plus AI usage. Set an AWS Budget alert at $10 as a backstop:

```bash
aws budgets create-budget --account-id <ACCOUNT_ID> --budget '{
  "BudgetName": "s2c-monthly", "BudgetLimit": {"Amount": "10", "Unit": "USD"},
  "TimeUnit": "MONTHLY", "BudgetType": "COST"}'
```
