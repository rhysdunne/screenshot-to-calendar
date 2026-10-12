# CLAUDE.md

> ⚠️ **This repository is PUBLIC** (portfolio/showcase). Everything committed —
> and everything in git *history* — is world-readable and effectively permanent.
> Before committing, assume it will be scraped and cannot be un-published:
> - **No secrets or PII in commits.** Secrets live in AWS SSM Parameter Store /
>   macOS Keychain (see the Secrets invariant below), never in the tree or env vars.
> - **Real user/eval data** must come from the owner's own account, needs the
>   user's recorded `consent` **and** any in-image third-party PII (names,
>   handles, faces) redacted *before* commit. Check the pixels, not just the
>   label. Keep source camera-roll filenames (`IMG_####`) out of `meta.json`.
> - **`docs/corrections-to-prompt-improvement.md` stays untracked** until the
>   prompt-injection / eval-poisoning gaps it documents are hardened — publishing
>   it maps live attack surface.
> - **No claude.ai links, AWS account IDs or local paths** in commits, PRs or
>   issues. `.claude/settings.json` turns off the automatic session link
>   (`attribution.sessionUrl: false`). Do not paste session, artifact or chat
>   links by hand either.

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
| `backend/src/lib/` | Clients and cross-cutting: `models.ts` (ALL model IDs, prices and per-stage tuning, the only place models are configured), `anthropic.ts` (single Claude entry point: sends the stage's tuning, logs `claude_call`, emits the spend metric), `google-*.ts`, `crypto.ts` (AES-256-GCM refresh-token encryption), `jwt.ts` (180-day app sessions), `ddb.ts`, `s3.ts`, `config.ts` (Parameter Store cache for the SecureStrings and the sign-up allowlist), `http.ts` (JWT middleware + response helpers), `logger.ts`. |
| `backend/src/handlers/` | Lambda handlers, each a one-argument async function. `process-capture.ts` is the pipeline orchestrator (SQS-triggered). The other files hold the API route handlers, one or more per file (`captures-read.ts` serves three routes). `infra/lib/backend-stack.ts` gives each route its own Lambda. `deps.ts` wires the real clients. |
| `backend/src/prompts/` | Versioned prompt files (`extract-event.v2.md` to `v4.md`, `classify-image.v1.md`) + `prompts.ts`, which pins the active version of each: `extract-event` v3 and `classify-image` v1. `extract-event.v4.md` is an unpinned candidate, because its review found a regression that repeats (ADR 0008). Prompt changes = new version file + bump the pin. Never edit an existing version in place, because eval reports reference them. |
| `infra/` | CDK app. `lib/backend-stack.ts` = the whole AWS shape; `lib/web-stack.ts` = CloudFront (AASA for universal links, /c/* fallback, privacy/terms). |
| `evals/` | Synthetic poster generator (Playwright), labeled datasets, scoring, model-comparison harness. `reports/baseline/` is the July 2026 run (prompt v2, Haiku 4.5 classify, the old Sonnet price). It stays as a historical reference until someone regenerates it. `reports/model-refresh-2026-10/` and `reports/prompt-v4-2026-10/` hold the evidence for ADRs 0007 and 0008. |
| `tools/prompt-improvement/` | The owner's consented corrections → clustered failure patterns → proposed prompt version → eval gate → PR. Runs on demand only (ADR 0006). |
| `ios/` | SwiftUI app + Share Extension. `project.yml` is the source of truth (XcodeGen); no .xcodeproj is committed. |
| `docs/` | Setup guides, architecture, CI/CD, privacy policy, ToS, ADRs (`decisions/`). `design-semantic-search.md` is a parked design: not built and not planned. |
| `scripts/` | Labelled operator commands: `secrets.sh` (Keychain and Parameter Store secrets), `allowlist.sh` (who may create an account), `sessions.sh` (sign users out). The header of each script documents its usage. |
| `justfile` | Labelled local entry points that copy what CI does. `just --list` shows them. When a workflow changes, change the matching recipe in the same PR. |
| `.tool-versions` | The Node major (`nodejs 22`) for CI and local tools. It moves together with the Lambda runtime and `@types/node` (see the Node invariant below). |
| `SHIPPING.md` | The ordered first-deploy runbook (Google → AWS → deploy → baseline eval → TestFlight). Completed in July 2026 and kept for reproduction. |

## Commands

Start with the justfile. Each recipe has a one-line description:

```bash
just --list                         # every recipe (a bare `just` does the same)
just install                        # npm ci in backend, infra, evals, tools/prompt-improvement
just check                          # what the PR checks run: typecheck, lint, tests, mock eval
just ios-build                      # unsigned iOS compile, like ios.yml (Mac only)
just eval                           # live eval of production's models. COSTS MONEY (about $0.85)
just deploy <stage>                 # ALERT_EMAIL check, cdk diff, typed confirmation, deploy
just logs <stage> <fn>              # follow one Lambda's logs, e.g. `just logs prod processor`
just dlq <stage>                    # count the messages on the dead-letter queue
just ship-ios                       # tag the next ios-v* build (Xcode Cloud → TestFlight)
```

Per package, for one step on its own:

```bash
cd backend && npm test              # vitest: pipeline, lib, handler tests (all mocked, no creds)
cd backend && npm run typecheck     # tsc --noEmit
cd infra   && npm test              # CDK assertions + synth
cd infra   && npx cdk synth         # render CloudFormation
cd evals   && npm run generate -- --count 40 --seed 42   # regenerate synthetic dataset
cd evals   && npm test              # scoring/generator unit tests (no API key)
cd evals   && npm run eval -- --models claude-haiku-4-5,claude-sonnet-5-5 --dataset synthetic
                                    # live eval, needs ANTHROPIC_API_KEY
```

## How work is tracked

- **Bugs / ideas / known issues → GitHub Issues** (labels: `bug`, `enhancement`,
  `chore`, `docs`, `prompt-eval`). When you notice an out-of-scope problem, file an
  issue rather than leaving a TODO in the code.
- **Big, reversible decisions → an ADR** under `docs/decisions/` (see its README for
  when one is warranted). When you make a non-obvious call someone will later
  question, record it. Small implementation choices stay in commit messages.
- **Rules the AI must always follow → an invariant in this file** (below), with the
  reason attached.
- Full model (memory tiers, enforcement layers, conventions): `CONTRIBUTING.md`.

## Conventions and invariants

- **Date/time**: never use `new Date().toISOString()` for "today" or date arithmetic —
  use `backend/src/pipeline/dates.ts` (`todayInZone`, `addDays`, etc.). The v1 bug this
  fixed: UTC "today" is wrong from midnight–1am BST. Google Calendar bodies always carry
  an explicit `timeZone` from user settings. New accounts start on `Europe/London`, and
  onboarding replaces it with the device's zone.
- **Models**: model IDs, prices, per-stage tuning (thinking, effort, max tokens) and
  defaults live ONLY in `backend/src/lib/models.ts`. Production classifies with
  `claude-haiku-5-5` and extracts with `claude-sonnet-5`, thinking off (ADR 0007). All
  Claude calls go through `lib/anthropic.ts`. It sends the stage's tuning, logs a
  `claude_call` line and emits the `AiCostUsd` metric. `process-capture.ts` stores the
  usage it returns as an `AICALL#` item, which expires after 90 days.
- **Prompts are versioned files**: to change extraction behaviour, create
  `extract-event.v{N+1}.md` and gate it against the pinned version with
  `tools/prompt-improvement` (`npm run gate -- --candidate v{N+1}`). The gate runs two
  fresh evals, candidate and pinned, and compares them case by case. It does not read
  the committed baseline, and no CI job gates a prompt PR. A machine-proposed candidate
  must pass the strict sign-test gate (ADR 0003). A human-written candidate runs the
  gate with `--report-only`, and the author reviews every changed case (ADR 0008).
  Bump the pin in `prompts.ts` only after that, and commit the reports with it.
- **Pipeline purity**: nothing in `backend/src/pipeline/` may import AWS SDK, fetch, or
  env vars. Handlers do I/O; pipeline functions take data and return data. This is what
  lets the eval harness run the real production post-processing.
- **DynamoDB single table** `s2c-main-{stage}`: `USER#<id>` partition; sort keys
  `PROFILE`, `CAPTURE#<ulid>`, `IMGHASH#<sha256>`, `CORRECTION#<ulid>`, `AICALL#<ulid>`.
  GSI1 = `GSUB#<googleSub>` → user lookup at sign-in. ULIDs give time-ordering for free.
- **Secrets**: AWS Systems Manager Parameter Store SecureStrings under `/s2c/{stage}/…`, cached in `lib/config.ts`.
  Never put secrets in Lambda env vars or CDK code. The sign-up allowlist
  (`/s2c/{stage}/signup-allowlist`) is a plain String beside them, managed with
  `scripts/allowlist.sh`.
- **Node version**: `.tool-versions`, the Lambda runtime and esbuild target in
  `infra/lib/backend-stack.ts` (`NODEJS_22_X`, `node22`), and `@types/node` in all four
  `package.json` files move together, in one PR. Otherwise CI and local runs can use
  Node APIs that production does not have. Bump only after AWS offers the new major as
  a Lambda runtime. Steps: `docs/ci-cd.md`.
- **API contract**: JSON shapes shared with iOS live in `docs/architecture.md` and are
  mirrored by `ios/Shared/Models.swift` — change both together.
- **Corrections**: `PATCH /v1/captures/{id}` must never overwrite the original `event`
  object (it is the training signal); user edits go in `corrected`.
- **Consent and owner-only data**: correction/image data may only be read by evals or
  prompt-improvement when the user's `consentEvalUse` was true at correction time
  (snapshotted on the CORRECTION item). Default is false. The data must also come from
  the owner's own account. `npm run aggregate` and `npm run materialize` read only the
  `USER#<OWNER_USER_ID>` partition, with a Query and never a table Scan, and refuse to
  run without `OWNER_USER_ID`. In CI, the aggregate step of `prompt-improvement.yml`
  gets it from the `OWNER_USER_ID` repository secret. Other users' data never reaches
  the proposer LLM or this public repo, even with consent. The eval loader also refuses
  a real case without `"consent": true` in its `meta.json`.

## Testing philosophy

- Pipeline functions: plain unit tests, including the 9 cases ported from v1
  (end-date-only → starts today, no dates → throws, late-night 23:59 clamp, fence
  stripping, etc.) plus DST regression tests (2026-03-29, 2026-10-25).
- Lib/handlers: `aws-sdk-client-mock` for AWS, injected fakes for Google/Anthropic.
  `process-capture` has full happy-path/dedup/not-event/failure e2e tests with mocks.
- Evals: synthetic posters are generated from the same data object as their gold
  labels, so ground truth is exact by construction. `meta.frozenToday` pins `{{TODAY}}`
  for deterministic relative-date cases.
- iOS: `ios.yml` compiles the app on a macOS runner (Xcode 26.6, no signing) as the
  required `ios-build` PR check. There is no XCTest target yet, so check behaviour on a
  device or simulator. `just ios-build` runs the same compile on a Mac. Keep
  `ios/Shared/Models.swift` in sync with API changes.

## Environments

- Stages: `staging` and `prod`, same AWS account, resources suffixed with the stage.
- Deploy (backend + web): a merge to `main` that touches `backend/`, `infra/`,
  `.tool-versions` or the deploy workflows auto-deploys staging. Then it pauses at a
  prod approval gate (GitHub Actions `deploy.yml`, OIDC role). Dispatch the workflow to
  redeploy. Locally, run `just deploy <stage>`. Both refuse to run with an empty
  `ALERT_EMAIL`. iOS ships separately via an `ios-v*` tag (`just ship-ios`) → Xcode
  Cloud → TestFlight. Full pipeline: `docs/ci-cd.md`.
- Release builds of the iOS app use prod. Debug builds use staging (`AppConfig.swift`).

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
- TestFlight builds expire after 90 days. Ship a build at least every 80 days, even with
  no app changes, so testers keep a working app. Run `just ship-ios`.
- Sign-up is invite-only. A new Google account gets an account only if its email is on
  `/s2c/{stage}/signup-allowlist` (`scripts/allowlist.sh add <stage> <email>`). A
  missing or empty list refuses every new sign-up. Existing accounts always sign in.
