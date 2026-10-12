# AWS setup

One-time setup from zero to a deployed backend. Everything runs in
**eu-west-2** (London) so data stays in the UK/EU.

> **Do the [Apple Team ID](setup-apple.md) and [Google](setup-google.md) setup
> first.** §3 (secrets) needs the Google OAuth client secret + Places key, and
> §4 (context) needs the Google **web** client id and your **Apple Team ID** —
> you cannot finish those AWS steps without them.

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

## 3. Secrets (AWS Systems Manager Parameter Store)

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

See [secrets.md](secrets.md) for a macOS Keychain helper (`scripts/secrets.sh`)
that stores these locally and pushes all five here in one command, plus which
secrets are regenerable if lost.

### Sign-up allowlist

Sign-up is invite-only. `POST /v1/auth/google` creates a new account only when
the Google account's verified email is on `/s2c/{stage}/signup-allowlist`. A
missing or empty list refuses every new sign-up, you included. Existing
accounts always sign in. Add yourself to each stage before you sign in for the
first time:

```bash
scripts/allowlist.sh add staging you@gmail.com
scripts/allowlist.sh add prod you@gmail.com
scripts/allowlist.sh list prod
```

The list is a plain String parameter, not a SecureString, because it holds
email addresses, not secrets. A change can take up to 5 minutes to reach a warm
Lambda container.

## 4. Configure context

`infra/cdk.json` holds these context values. This repo commits its own values,
because they ship inside the app and are not secret. A fork replaces them:

- `googleClientId` — the **web** OAuth client id (setup-google.md step 3)
- `appleTeamId` — your Apple Developer Team ID (setup-apple.md)
- `iosBundleId` — `digital.callaeas.s2c` (must match `ios/project.yml`)

The ops alarm address is not in `cdk.json`, because this repo is public. Set it
as the `ALERT_EMAIL` environment variable for local deploys, and as a repo
variable for CI (§6). The alarms cover the DLQ, Lambda errors, API 5xx
(`s2c-api-5xx-*`) and daily AI spend over $2. After the first deploy,
**confirm the SNS subscription email** AWS sends you, or the alarms notify no
one.

## 5. Deploy

```bash
export ALERT_EMAIL=you@example.com
just deploy staging
just deploy prod
```

Each `just deploy` shows a `cdk diff` and asks you to type the stage name
before it deploys. It refuses to run when `ALERT_EMAIL` is empty. Install
`just` first if you do not have it (`brew install just`). Details:
[deploy.md](deploy.md).

Note the outputs:

- `S2cWeb-*.WebDomain` → the CloudFront domain. Paste (without scheme) into
  `ios/project.yml` (Associated Domains) and `ios/Shared/AppConfig.swift`.
- `S2cBackend-*.ApiUrl` → paste into `ios/Shared/AppConfig.swift`.

Verify:

```bash
curl "<ApiUrl>/v1/health"                     # {"status":"ok","stage":"..."}
curl "https://<WebDomain>/.well-known/apple-app-site-association"
```

## 6. GitHub Actions (optional but recommended)

Two workflows assume an AWS role through GitHub OIDC, so GitHub stores no
long-lived AWS keys. Each one presents a different OIDC subject, and the role
must trust both:

| Workflow | What it does in AWS | OIDC subject |
|---|---|---|
| `deploy.yml` (through `deploy-stage.yml`) | CDK deploy of both stacks | `repo:<owner>/<repo>:environment:staging` or `repo:<owner>/<repo>:environment:prod`, because the job sets `environment:` |
| `prompt-improvement.yml` | Queries the owner's partition of the prod table for consented corrections (`npm run aggregate`) | `repo:<owner>/<repo>:ref:refs/heads/main` when you dispatch it from `main` |

For this repo, `<owner>/<repo>` is `rhysdunne/screenshot-to-calendar`.

1. Create the OIDC identity provider (once per account):
   ```bash
   aws iam create-open-id-connect-provider \
     --url https://token.actions.githubusercontent.com \
     --client-id-list sts.amazonaws.com
   ```
   No `--thumbprint-list` is needed. AWS checks GitHub's certificate itself.
2. Write the trust policy to `$HOME/s2c-github-trust.json`. Keep it outside the
   repo, because it holds your account id. Replace `<ACCOUNT_ID>`, `<owner>`
   and `<repo>`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": [
               "repo:<owner>/<repo>:environment:staging",
               "repo:<owner>/<repo>:environment:prod",
               "repo:<owner>/<repo>:ref:refs/heads/main"
             ]
           }
         }
       }
     ]
   }
   ```
3. Create the role and give it deploy permissions:
   ```bash
   aws iam create-role --role-name s2c-github-deploy \
     --assume-role-policy-document file://$HOME/s2c-github-trust.json
   aws iam attach-role-policy --role-name s2c-github-deploy \
     --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
   ```
   `AdministratorAccess` is a starting point. Issue
   [#33](https://github.com/rhysdunne/screenshot-to-calendar/issues/33) tracks
   the move to least-privilege permissions.
4. Create the `staging` and `prod` environments (Settings → Environments). Add a
   required reviewer to `prod`, so every prod deploy waits for your approval.
5. Add the repository **variables** (Settings → Secrets and variables → Actions
   → Variables). They are not secret, but they stay out of the public source:

   | Variable | Value | Read by |
   |---|---|---|
   | `AWS_DEPLOY_ROLE_ARN` | the ARN of `s2c-github-deploy` | `deploy-stage.yml`, `prompt-improvement.yml` |
   | `ALERT_EMAIL` | the ops alarm address | `deploy-stage.yml`, which fails when it is empty |
   | `AWS_ACCOUNT_ID` | your 12-digit account id | `prompt-improvement.yml`, for its inline session policy |

6. Add the repository **secrets** (the Secrets tab on the same page):

   | Secret | Value | Read by |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | an Anthropic API key | `eval-weekly.yml`, `prompt-improvement.yml` |
   | `OWNER_USER_ID` | your own userId, the ULID after `USER#` on your PROFILE item | the aggregate step of `prompt-improvement.yml` |

   `OWNER_USER_ID` is a secret, not a variable, so GitHub masks the value in the
   public logs. The aggregate step passes it to `npm run aggregate`, which runs
   a DynamoDB Query on the `USER#<OWNER_USER_ID>` partition and reads no other
   account. Without it, the aggregate step stops with `Set OWNER_USER_ID`.
   The header of `tools/prompt-improvement/src/materialize-eval-cases.ts` shows
   how to look up your userId.
7. Run the **Deploy** workflow from the Actions tab. It deploys staging, then
   waits for approval before prod.

## Tighten the deploy role

This section is for an account that already has the role with a repo-wide
trust, `repo:<owner>/<repo>:*` (issue
[#34](https://github.com/rhysdunne/screenshot-to-calendar/issues/34)). That
trust lets a workflow on any branch, pull request or tag assume a role with
`AdministratorAccess`. Replace it with the three subjects from §6:

1. Look at the trust that is live now:
   ```bash
   aws iam get-role --role-name s2c-github-deploy \
     --query Role.AssumeRolePolicyDocument
   ```
2. Write the trust policy from §6 step 2 to `$HOME/s2c-github-trust.json`.
3. Replace the trust:
   ```bash
   aws iam update-assume-role-policy --role-name s2c-github-deploy \
     --policy-document file://$HOME/s2c-github-trust.json
   ```
4. Dispatch **Deploy** and let staging finish. Leave the prod gate unapproved.
5. Dispatch **Prompt improvement** from `main`. Make sure that it gets past the
   AWS credentials step.

After this change, a Prompt improvement run that you dispatch from another
branch fails with AccessDenied at the credentials step. This is intended. The
role still has `AdministratorAccess`. Issue
[#33](https://github.com/rhysdunne/screenshot-to-calendar/issues/33) tracks a
least-privilege policy and a separate role for prompt improvement.

## Costs

Personal-scale usage sits inside the always-free tiers of Lambda, DynamoDB
on-demand, and SQS. Real money: S3/CloudFront (pennies), CloudWatch logs
(30-day retention configured), Anthropic API (about $0.006/capture). Expect
≲ $2/month plus AI usage. Set an AWS Budget alert at $10 as a backstop. It
emails you when actual spend passes 80% of the limit:

```bash
aws budgets create-budget --account-id <ACCOUNT_ID> \
  --budget '{"BudgetName": "s2c-monthly", "BudgetLimit": {"Amount": "10", "Unit": "USD"},
    "TimeUnit": "MONTHLY", "BudgetType": "COST"}' \
  --notifications-with-subscribers '[{
    "Notification": {"NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80, "ThresholdType": "PERCENTAGE"},
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "you@example.com"}]}]'
```

A budget with no subscriber notifies nobody.
