# Deploying

## Backend + web (CDK)

Local:

```bash
cd infra
export ALERT_EMAIL=you@example.com   # ops alarm address; kept out of source (public repo)
npx cdk diff S2cBackend-staging      # review
npx cdk deploy S2cWeb-staging S2cBackend-staging
# validate on staging, then:
npx cdk deploy S2cWeb-prod S2cBackend-prod
```

`ALERT_EMAIL` is the address AWS subscribes to the CloudWatch alarms topic. It's
non-secret but personal, so it lives in your environment, not `cdk.json`. Omit it
and the stack still deploys — alarms just have no email subscriber.

GitHub Actions: run the **Deploy** workflow (Actions tab → Deploy → Run
workflow → pick stage). Requires the `AWS_DEPLOY_ROLE_ARN` and `ALERT_EMAIL`
repository **variables** (Settings → Secrets and variables → Actions → Variables;
see docs/setup-aws.md §6).

The iOS app points at prod in Release builds and staging in Debug builds
(`ios/Shared/AppConfig.swift`).

## Adopting the v3 prompt (price + category)

`extract-event.v3.md` ships as a **candidate** adding `price` and `category`
(issues #4/#7); its schema is wired via `extractSchemaFor()` and the eval
harness/generator already score the new fields. To adopt it:

```bash
cd tools/prompt-improvement
ANTHROPIC_API_KEY=... npm run gate -- --candidate v3
# gate passed → bump ACTIVE_VERSIONS['extract-event'] to 'v3' in
# backend/src/prompts/prompts.ts, commit with the gate report, deploy
```

## Changing the extraction prompt

1. Create `backend/src/prompts/extract-event.v{N+1}.md` (never edit an
   existing version — eval baselines reference them).
2. Gate it: `cd tools/prompt-improvement && ANTHROPIC_API_KEY=... npm run gate -- --candidate v{N+1}`
3. If the gate passes, bump `ACTIVE_VERSIONS` in
   `backend/src/prompts/prompts.ts`, commit the version file + gate report,
   PR, merge, deploy.

The scheduled prompt-improvement workflow automates steps 1–2 from user
corrections; adoption is always a human-reviewed PR.

## Changing the models

Edit `backend/src/lib/models.ts` (defaults) or set `CLASSIFY_MODEL` /
`EXTRACT_MODEL` on the Lambdas via `infra/lib/backend-stack.ts`. Run the eval
first: `cd evals && npm run eval -- --models <candidates> --dataset all` and
compare the report against the committed baseline.

## Operations

- **Logs**: `aws logs tail /aws/lambda/s2c-processor-prod --follow --region eu-west-2`
- **DLQ alarm** (`s2c-dlq-not-empty-*`) fires when a capture failed 3×.
  Inspect: `aws sqs receive-message --queue-url <dlq-url>`; after fixing,
  redrive from the SQS console.
- **Cost per capture**: query `AICALL#` items, or check the `claude_call`
  structured logs.
- **Revoke all sessions for a user**: increment `tokenVersion` on their
  `USER#…/PROFILE` item.
