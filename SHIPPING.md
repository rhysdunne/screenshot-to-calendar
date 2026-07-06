# Shipping checklist

Everything below is one-time setup, in dependency order. Detailed
walkthroughs live in `docs/` — this page is the sequence. Tick as you go.

## 1. Apple Team ID (≈5 min) — [docs/setup-apple.md](docs/setup-apple.md)

You only need the **Team ID** now; the full Apple/TestFlight flow is step 7,
after the backend is deployed. Everything downstream — the `cdk.json` context
and the universal-links AASA — depends on it.

- [ ] Apple Developer Program membership active ($99/year)
- [ ] Copy your **Team ID** from
      [developer.apple.com](https://developer.apple.com/account) → Membership

## 2. Google Cloud (≈30 min) — [docs/setup-google.md](docs/setup-google.md)

Produces every credential the AWS step then consumes, so it comes before AWS.

- [ ] Project created; **Calendar API** + **Places API (New)** enabled
- [ ] OAuth consent screen: External, calendar scope, then **publish to
      Production** ⚠️ — in Testing status refresh tokens die every 7 days
      and the app silently breaks
- [ ] **iOS OAuth client** → client id + reversed id (used in `ios/project.yml`
      at step 7)
- [ ] **Web OAuth client** → id (→ `infra/cdk.json`, step 3); secret (→ AWS
      Systems Manager Parameter Store, step 3)
- [ ] Places API key (restricted to Places API (New)) → Parameter Store, step 3
- [ ] *Deferred:* the consent-screen **privacy/terms URLs** need the deployed
      `WebDomain` — save the screen without them and fill them in after step 4

## 3. AWS (≈30 min) — [docs/setup-aws.md](docs/setup-aws.md)

With the Apple Team ID (step 1) and Google credentials (step 2) in hand, this
now completes end to end.

- [ ] AWS account with MFA; CLI configured (`aws sts get-caller-identity`)
- [ ] `cd infra && npm ci && npx cdk bootstrap aws://<ACCOUNT_ID>/eu-west-2`
- [ ] Create the 5 Parameter Store SecureStrings **per stage** (staging, then prod):
  ```bash
  STAGE=staging
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/anthropic-api-key --value 'sk-ant-...'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/google-oauth-client-secret --value '<web client secret, step 2>'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/places-api-key --value '<Places key, step 2>'
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/jwt-secret --value "$(openssl rand -hex 32)"
  aws ssm put-parameter --region eu-west-2 --type SecureString --name /s2c/$STAGE/token-enc-key --value "$(openssl rand -hex 32)"
  ```
- [ ] Fill `infra/cdk.json` context: `googleClientId` (web id, step 2),
      `appleTeamId` (step 1), `alertEmail`. `iosBundleId` is already
      `digital.callaeas.s2c`.

## 4. Deploy (≈15 min) — [docs/deploy.md](docs/deploy.md)

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
- [ ] Back to step 2: add `https://<WebDomain>/privacy.html` and `/terms.html`
      to the Google consent screen now that the domain exists

## 5. First live eval baseline (≈10 min, ~$0.50)

The datum every future model/prompt decision compares against.

- [ ] `cd evals && ANTHROPIC_API_KEY=... npm run eval -- --models claude-haiku-4-5,claude-sonnet-5 --dataset all --label baseline`
- [ ] Read `evals/reports/baseline/report.md` — decide whether Haiku is good
      enough (see [evals/README.md](evals/README.md) for how to read it);
      commit the report
- [ ] GitHub repo settings: secret `ANTHROPIC_API_KEY`; variables
      `AWS_DEPLOY_ROLE_ARN` (docs/setup-aws.md §6) and `AWS_ACCOUNT_ID` —
      enables the deploy, nightly-eval, and prompt-improvement workflows

## 6. Optional now: adopt prompt v3 (price + category)

- [ ] `cd tools/prompt-improvement && ANTHROPIC_API_KEY=... npm run gate -- --candidate v3`
- [ ] Green → bump `ACTIVE_VERSIONS['extract-event']` to `'v3'` in
      `backend/src/prompts/prompts.ts`, commit with the gate report, redeploy

## 7. Apple / TestFlight (≈1–2 h first time) — [docs/setup-apple.md](docs/setup-apple.md)

Every value now exists: Team ID (step 1), both OAuth client ids (step 2),
`WebDomain` + API URLs (step 4).

- [ ] Replace every placeholder (table in [ios/README.md](ios/README.md)):
      team id, both OAuth client ids, CloudFront domain, both API URLs
- [ ] `brew install xcodegen && cd ios && xcodegen generate`
- [ ] Open in Xcode, team selected, capabilities provision cleanly
- [ ] Run on your iPhone; sign in (expect the "unverified app" warning)
- [ ] Archive → upload → TestFlight **internal** group (no App Review)

## 8. End-to-end smoke on the phone

- [ ] Sign in → onboarding → create/pick a calendar
- [ ] Share a real event poster from Photos → "Capture Event"
- [ ] Open the app: capture completes → event in Google Calendar
- [ ] Tap the "View capture" link inside the calendar event → app opens the
      original image (universal link; if Safari opens instead, see
      docs/setup-apple.md §3.5)
- [ ] Edit a field, save → calendar event updates
- [ ] Share the same image again → "Already in calendar" (dedup)

## 9. Then: use it for two weeks

- Every wrong extraction: correct it in-app; consented corrections become
  eval cases via `npm run materialize` — see
  [docs/adding-eval-images.md](docs/adding-eval-images.md) for hand-adding
  interesting failures too
- Watch for alarm emails (DLQ, Lambda errors, AI spend > $2/day)
- What you wish it did after two weeks is the roadmap — the semantic-search
  design ([docs/design-semantic-search.md](docs/design-semantic-search.md))
  is waiting to be validated against that.

---

**Later — custom domain.** The app ships on the default CloudFront domain, and
universal links work fine on it. When you want `callaeas.digital` as the
web/universal-links host, that's a separate task: a Route53 hosted zone (or DNS
delegation) + an ACM certificate in **us-east-1** + a CloudFront alternate
domain, then `applinks:callaeas.digital` in `ios/project.yml` and `webDomain`
in `ios/Shared/AppConfig.swift`.
