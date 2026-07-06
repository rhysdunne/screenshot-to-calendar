# Shipping checklist

Everything below is one-time setup, in dependency order. Detailed
walkthroughs live in `docs/` — this page is the sequence. Tick as you go.

## 1. AWS (≈30 min) — [docs/setup-aws.md](docs/setup-aws.md)

- [ ] AWS account with MFA; CLI configured (`aws sts get-caller-identity`)
- [ ] `cd infra && npm ci && npx cdk bootstrap aws://<ACCOUNT_ID>/eu-west-2`
- [ ] Create the 5 SSM SecureStrings **per stage** (staging, then prod):
  ```bash
  STAGE=staging
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/anthropic-api-key --value 'sk-ant-...'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/google-oauth-client-secret --value '<from step 2>'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/places-api-key --value '<from step 2>'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/jwt-secret --value "$(openssl rand -hex 32)"
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/token-enc-key --value "$(openssl rand -hex 32)"
  ```
  (Google values arrive in step 2 — you can create those two parameters then.)
- [ ] Fill `infra/cdk.json` context: `googleClientId` (step 2), `appleTeamId`,
      `iosBundleId`, **`alertEmail`**

## 2. Google Cloud (≈30 min) — [docs/setup-google.md](docs/setup-google.md)

- [ ] Project created; **Calendar API** + **Places API (New)** enabled
- [ ] OAuth consent screen: External, calendar scope, then **publish to
      Production** ⚠️ — in Testing status refresh tokens die every 7 days
      and the app silently breaks
- [ ] **iOS OAuth client** → client id + reversed id → `ios/project.yml`
- [ ] **Web OAuth client** → id → `infra/cdk.json`; secret → SSM
- [ ] Places API key (restricted to Places API (New)) → SSM

## 3. Deploy (≈15 min) — [docs/deploy.md](docs/deploy.md)

- [ ] `cd infra && npx cdk deploy S2cWeb-staging S2cBackend-staging`
- [ ] Same for prod: `npx cdk deploy S2cWeb-prod S2cBackend-prod`
- [ ] **Confirm the SNS subscription email** AWS sends to `alertEmail` —
      until you click it, alarms notify no one
- [ ] Record outputs: `ApiUrl` (both stages) and `WebDomain`
- [ ] Verify:
  ```bash
  curl "<ApiUrl>/v1/health"
  curl "https://<WebDomain>/.well-known/apple-app-site-association"
  ```

## 4. First live eval baseline (≈10 min, ~$0.50)

The datum every future model/prompt decision compares against.

- [ ] `cd evals && ANTHROPIC_API_KEY=... npm run eval -- --models claude-haiku-4-5,claude-sonnet-5 --dataset all --label baseline`
- [ ] Read `evals/reports/baseline/report.md` — decide whether Haiku is good
      enough (see [evals/README.md](evals/README.md) for how to read it);
      commit the report
- [ ] GitHub repo settings: secret `ANTHROPIC_API_KEY`; variables
      `AWS_DEPLOY_ROLE_ARN` (docs/setup-aws.md §6) and `AWS_ACCOUNT_ID` —
      enables the deploy, nightly-eval, and prompt-improvement workflows

## 5. Optional now: adopt prompt v3 (price + category)

- [ ] `cd tools/prompt-improvement && ANTHROPIC_API_KEY=... npm run gate -- --candidate v3`
- [ ] Green → bump `ACTIVE_VERSIONS['extract-event']` to `'v3'` in
      `backend/src/prompts/prompts.ts`, commit with the gate report, redeploy

## 6. Apple / TestFlight (≈1–2 h first time) — [docs/setup-apple.md](docs/setup-apple.md)

- [ ] Replace every placeholder (table in [ios/README.md](ios/README.md)):
      team id, both OAuth client ids, CloudFront domain, both API URLs
- [ ] `brew install xcodegen && cd ios && xcodegen generate`
- [ ] Open in Xcode, team selected, capabilities provision cleanly
- [ ] Run on your iPhone; sign in (expect the "unverified app" warning)
- [ ] Archive → upload → TestFlight **internal** group (no App Review)

## 7. End-to-end smoke on the phone

- [ ] Sign in → onboarding → create/pick a calendar
- [ ] Share a real event poster from Photos → "Capture Event"
- [ ] Open the app: capture completes → event in Google Calendar
- [ ] Tap the "View capture" link inside the calendar event → app opens the
      original image (universal link; if Safari opens instead, see
      docs/setup-apple.md §3.5)
- [ ] Edit a field, save → calendar event updates
- [ ] Share the same image again → "Already in calendar" (dedup)

## 8. Then: use it for two weeks

- Every wrong extraction: correct it in-app; consented corrections become
  eval cases via `npm run materialize` — see
  [docs/adding-eval-images.md](docs/adding-eval-images.md) for hand-adding
  interesting failures too
- Watch for alarm emails (DLQ, Lambda errors, AI spend > $2/day)
- What you wish it did after two weeks is the roadmap — the semantic-search
  design ([docs/design-semantic-search.md](docs/design-semantic-search.md))
  is waiting to be validated against that.
