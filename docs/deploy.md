# Deploying

## Backend + web (CDK)

A merge to `main` deploys automatically (see [ci-cd.md](ci-cd.md)). To deploy
from your own machine:

```bash
export ALERT_EMAIL=$(gh variable get ALERT_EMAIL)   # ops alarm address, kept out of source (public repo)
just deploy staging
# validate on staging, then:
just deploy prod
```

`just deploy <stage>` installs the backend and infra packages and shows a
`cdk diff` of both stacks. Then it asks you to type the stage name. It deploys
`S2cWeb-<stage>` and `S2cBackend-<stage>` only after you confirm.

`ALERT_EMAIL` is the address AWS subscribes to the CloudWatch alarms topic. It
is not secret, but it is personal, so it lives in your environment and in a
repository variable, not in `cdk.json`. An empty value still deploys, but the
stack then drops the email subscription and the alarms notify nobody. For this
reason `just deploy` and the CI deploy (`deploy-stage.yml`) both refuse to run
when `ALERT_EMAIL` is empty.

GitHub Actions: run the **Deploy** workflow (Actions tab → Deploy → Run
workflow). It runs CI, deploys staging, then waits for approval before prod.
Leave the prod gate unapproved to redeploy staging only. It needs the
`AWS_DEPLOY_ROLE_ARN` and `ALERT_EMAIL` repository **variables** (Settings →
Secrets and variables → Actions → Variables). See
[setup-aws.md](setup-aws.md) §6.

The iOS app points at prod in Release builds and staging in Debug builds
(`ios/Shared/AppConfig.swift`).

## Changing the extraction prompt

Prompt versions are immutable files. One pin, `ACTIVE_VERSIONS` in
`backend/src/prompts/prompts.ts`, selects the live version
([ADR 0003](decisions/0003-prompt-change-control.md)). Today the pin is
`extract-event` v3. `extract-event.v4.md` is a candidate that its review did
not adopt.

For a prompt fix that you write yourself
([ADR 0008](decisions/0008-human-written-prompt-review.md)):

1. Create `backend/src/prompts/extract-event.v{N+1}.md`. Never edit an existing
   version, because eval reports reference them.
2. Run the gate in report mode:
   `cd tools/prompt-improvement && ANTHROPIC_API_KEY=... npm run gate -- --candidate v{N+1} --report-only`
3. Read `per-case.md`. Make sure that the targeted cases are fixed and that no
   case loses a field.
4. Re-run each regression once on both versions with `--cases` (the command is
   in ADR 0008). A regression that repeats blocks the candidate.
5. If the review passes, bump `ACTIVE_VERSIONS` in `prompts.ts`. Commit the
   version file, the pin and the reports under `evals/reports/` in one PR.

A candidate from the prompt-improvement workflow must pass the strict gate,
without `--report-only`. That workflow runs on demand only
([ADR 0006](decisions/0006-prompt-improvement-manual-only.md)). It proposes
candidates from the owner's consented corrections. Adoption is always a
human-reviewed PR.

## Changing the models

Edit `DEFAULT_MODELS` in `backend/src/lib/models.ts`. To override one stage
without a code change, add `CLASSIFY_MODEL` or `EXTRACT_MODEL` to the Lambda
environment in `infra/lib/backend-stack.ts`. A model needs prices and
per-stage tuning in `MODELS` first, or the Lambda fails at cold start.

Run the eval first: `just eval <model-a>,<model-b>` runs the full dataset.
Compare the result with a fresh run of the current models, not with the July
baseline in `evals/reports/baseline/`.
[ADR 0007](decisions/0007-model-refresh-2026-10.md) shows the method. Record
the choice in a new ADR.

## Operations

- **Logs**: `just logs prod processor` follows the processor's logs. Any Lambda
  works: give its CDK name in any case, for example `authgoogle` or
  `capturescreate`. A third argument sets the look-back window (default `10m`).
- **DLQ alarm** (`s2c-dlq-not-empty-*`) fires when a capture failed processing
  3 times. A failure that a retry cannot fix (no date, an end that is not after
  the start, a model refusal, a Google grant that needs a new sign-in) goes to
  `failed` at once and never reaches the DLQ. So the DLQ holds only failures
  that a retry might have fixed. `just dlq prod` counts the messages. After you
  fix the cause, redrive from the SQS console.
- **API 5xx alarm** (`s2c-api-5xx-*`) fires when the HTTP API returns any 5xx.
  Look for `unhandled_error` in the logs of the route Lambdas
  (`/aws/lambda/s2c-<route>-prod`), for example
  `just logs prod capturesupdate 1h`. The log line carries the error class,
  code, upstream status and Google reason.
- **Other alarms**: `s2c-processor-errors-*` and `s2c-authgoogle-errors-*`
  (Lambda errors), and `s2c-ai-spend-*` (Anthropic spend over $2 in 24 hours).
- **Cost per capture**: query `AICALL#` items (kept for 90 days), or check the
  `claude_call` structured logs.
- **Sign users out**: `scripts/sessions.sh revoke-user <stage> <email>` bumps
  one user's `tokenVersion`. `scripts/sessions.sh revoke-all <stage>` rotates
  `jwt-secret` and signs out every user.
- **Let someone sign up**: `scripts/allowlist.sh add <stage> <email>`. Sign-up
  is invite-only.
- **Prod data outlives the stack**: the prod table and images bucket use a
  RETAIN removal policy, so a stack delete leaves them in place. The prod table
  also has deletion protection. A delete from the console or the CLI fails until
  you turn deletion protection off by hand.
