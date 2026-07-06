# CLAUDE.md

## Project: screenshot-to-calendar

Production AI product that turns screenshots of event posters/Instagram posts into
Google Calendar events. Native SwiftUI iOS app (TestFlight) + serverless AWS backend
(Lambda, DynamoDB, S3, SQS, eu-west-2) + Claude vision pipeline + eval harness.
Replaced a v1 n8n/Scriptable pipeline, preserved in `archive/` (see `archive/README.md`
for the port map).

## Layout

| Path | Purpose |
|---|---|
| `backend/src/pipeline/` | **Pure functions, no AWS/network imports.** Date math (`dates.ts` — all arithmetic in the user's IANA timezone, never bare `new Date()`), extraction parsing, calendar mapping, image sniffing, dedup. Unit tests mirror in `backend/test/pipeline/`. |
| `backend/src/lib/` | Clients and cross-cutting: `models.ts` (ALL model IDs + prices — the only place models are configured), `anthropic.ts` (single Claude entry point, logs cost per call), `google-*.ts`, `crypto.ts` (AES-256-GCM refresh-token encryption), `jwt.ts`, `ddb.ts`, `s3.ts`, `config.ts` (SSM SecureString cache), `http.ts` (JWT middleware + response helpers), `logger.ts`. |
| `backend/src/handlers/` | One file per Lambda. `process-capture.ts` is the pipeline orchestrator (SQS-triggered); everything else is an API route. |
| `backend/src/prompts/` | Versioned prompt files (`extract-event.v2.md`, `classify-image.v1.md`) + `prompts.ts` which pins the ACTIVE version. Prompt changes = new version file + bump the pin; never edit an existing version in place (eval baselines reference them). |
| `infra/` | CDK app. `lib/backend-stack.ts` = the whole AWS shape; `lib/web-stack.ts` = CloudFront (AASA for universal links, /c/* fallback, privacy/terms). |
| `evals/` | Synthetic poster generator (Playwright), labeled datasets, scoring, model-comparison harness. |
| `tools/prompt-improvement/` | Corrections → clustered failure patterns → proposed prompt version → eval gate → PR. |
| `ios/` | SwiftUI app + Share Extension. `project.yml` is the source of truth (XcodeGen); no .xcodeproj is committed. |
| `docs/` | Setup guides, architecture, privacy policy, ToS. |

## Commands

```bash
cd backend && npm test              # vitest: pipeline, lib, handler tests (all mocked, no creds)
cd backend && npm run typecheck     # tsc --noEmit
cd infra   && npm test              # CDK assertions + synth
cd infra   && npx cdk synth         # render CloudFormation
cd evals   && npm run generate -- --count 40 --seed 42   # regenerate synthetic dataset
cd evals   && npm test              # scoring/generator unit tests (no API key)
cd evals   && npm run eval -- --models claude-haiku-4-5,claude-sonnet-5 --dataset synthetic
                                    # live eval, needs ANTHROPIC_API_KEY
```

## Conventions and invariants

- **Date/time**: never use `new Date().toISOString()` for "today" or date arithmetic —
  use `backend/src/pipeline/dates.ts` (`todayInZone`, `addDays`, etc.). The v1 bug this
  fixed: UTC "today" is wrong from midnight–1am BST. Google Calendar bodies always carry
  an explicit `timeZone` from user settings (default `Europe/London`).
- **Models**: model IDs, prices, and defaults live ONLY in `backend/src/lib/models.ts`.
  All Claude calls go through `lib/anthropic.ts` (it records tokens/cost to DynamoDB).
- **Prompts are versioned files**: to change extraction behaviour, create
  `extract-event.v{N+1}.md`, bump the pin in `prompts.ts`, and run the evals — CI's
  prompt gate compares against the baseline report.
- **Pipeline purity**: nothing in `backend/src/pipeline/` may import AWS SDK, fetch, or
  env vars. Handlers do I/O; pipeline functions take data and return data. This is what
  lets the eval harness run the real production post-processing.
- **DynamoDB single table** `s2c-main-{stage}`: `USER#<id>` partition; sort keys
  `PROFILE`, `CAPTURE#<ulid>`, `IMGHASH#<sha256>`, `CORRECTION#<ulid>`, `AICALL#<ulid>`.
  GSI1 = `GSUB#<googleSub>` → user lookup at sign-in. ULIDs give time-ordering for free.
- **Secrets**: SSM SecureStrings under `/s2c/{stage}/…`, cached in `lib/config.ts`.
  Never put secrets in Lambda env vars or CDK code.
- **API contract**: JSON shapes shared with iOS live in `docs/architecture.md` and are
  mirrored by `ios/Shared/Models.swift` — change both together.
- **Corrections**: `PATCH /v1/captures/{id}` must never overwrite the original `event`
  object (it is the training signal); user edits go in `corrected`.
- **Consent**: correction/image data may only be read by evals or prompt-improvement
  when the user's `consentEvalUse` was true at correction time (snapshotted on the
  CORRECTION item). Default is false.

## Testing philosophy

- Pipeline functions: plain unit tests, including the 9 cases ported from v1
  (end-date-only → starts today, no dates → throws, late-night 23:59 clamp, fence
  stripping, etc.) plus DST regression tests (2026-03-29, 2026-10-25).
- Lib/handlers: `aws-sdk-client-mock` for AWS, injected fakes for Google/Anthropic.
  `process-capture` has full happy-path/dedup/not-event/failure e2e tests with mocks.
- Evals: synthetic posters are generated from the same data object as their gold
  labels, so ground truth is exact by construction. `meta.frozenToday` pins `{{TODAY}}`
  for deterministic relative-date cases.
- iOS cannot be compiled in Linux CI; Swift changes are review-only here and built on
  a Mac (`xcodegen generate` then Xcode). Keep `ios/Shared/Models.swift` in sync with
  API changes.

## Environments

- Stages: `staging` and `prod`, same AWS account, resources suffixed with the stage.
- Deploy: GitHub Actions `deploy.yml` (workflow_dispatch, OIDC role) or
  `cd infra && npx cdk deploy S2c-{stage}`.
- The iOS app points at prod; Debug builds can flip to staging in `AppConfig.swift`.

## Gotchas

- Google OAuth consent screen must be published to **Production** (even unverified);
  in Testing status, refresh tokens expire after 7 days and every user silently breaks.
- Google Calendar all-day events use an **exclusive** end date (+1 day).
- Anthropic structured outputs (`output_config.format`) are used for both Claude calls,
  but `pipeline/extract.ts` keeps the markdown-fence-stripping fallback so eval
  candidate models without structured-output support still parse.
- API Gateway HTTP API payload cap is 10MB; images are client-resized (longest edge
  1000px, JPEG 0.8) before upload, so bodies stay ~500KB.
- Share extensions have a ~120MB memory ceiling — resize before base64-encoding.
