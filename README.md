# screenshot-to-calendar

Turn screenshots and photos of event posters, flyers, and Instagram posts into
Google Calendar events. Share an image from your iPhone → the app classifies it,
extracts the event with Claude, resolves the venue with Google Places, checks for
duplicates, and creates a calendar event with a link back to the source image.

Built to solve the universal habit of screenshotting things you want to do and
then never acting on them.

## Architecture

```
iOS app (SwiftUI) ── Share Extension receives image, resizes, uploads
   │
   ▼
API Gateway (HTTP API) ── JWT auth (Sign in with Google)
   │
   ▼
Lambda: captures-create ──► S3 (image) + DynamoDB (capture) + SQS
                                                                │
                                                                ▼
                                              Lambda: process-capture
                                                classify (Claude Haiku)
                                                extract  (Claude Sonnet, structured output)
                                                resolve venue (Google Places)
                                                gate     (low confidence → needs_review)
                                                adopt    (an event that already links to this capture)
                                                dedup    (fuzzy title + date window)
                                                create Google Calendar event
                                                  └─ description links back to the app
```

Everything runs in **eu-west-2** on the AWS free tier (Lambda + DynamoDB on-demand +
S3 + SQS + CloudFront). Steady-state cost is ≲ $2/month plus about $0.006 of
Anthropic API per capture.

The `adopt` step stops a retried capture from making a second event. If an event
in the date window already carries this capture's `/c/<captureId>` link, the
capture adopts that event and updates it. It does not create a new event or mark
itself as a duplicate.

## Repository layout

| Directory | What it is |
|---|---|
| `backend/` | TypeScript Lambda application: handlers, pure pipeline functions, prompt files, AWS/Google/Anthropic clients. `npm test` runs the full suite. |
| `infra/` | AWS CDK app (TypeScript). `BackendStack` (DynamoDB, S3, SQS, Lambdas, HTTP API) + `WebStack` (CloudFront for universal links, privacy policy, capture fallback pages). |
| `evals/` | Eval harness for the AI pipeline: synthetic poster generator (Playwright), labeled dataset, field-level scoring, model comparison reports. |
| `tools/prompt-improvement/` | Offline pipeline that turns the owner's consented corrections into candidate prompt changes, gated by the eval suite and human PR review. Run by hand. |
| `ios/` | Native SwiftUI app + Share Extension. Project generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml`. |
| `docs/` | Setup guides (AWS, Google Cloud, Apple), architecture notes, CI/CD, ADRs, privacy policy, terms of service. |
| `scripts/` | Operator commands: secrets (`secrets.sh`), the sign-up allowlist (`allowlist.sh`) and session revocation (`sessions.sh`). |
| `archive/` | The original n8n + Scriptable pipeline this replaced. Reference only. |

## Getting started

**Deploying for the first time? Follow [SHIPPING.md](SHIPPING.md)** — the
single ordered checklist from empty AWS account to TestFlight. It links into
the three detailed guides:

1. **[docs/setup-aws.md](docs/setup-aws.md)** — AWS account, CDK bootstrap, secrets in
   AWS Systems Manager Parameter Store, deploy staging + prod.
2. **[docs/setup-google.md](docs/setup-google.md)** — Google Cloud project, Calendar +
   Places APIs, OAuth consent screen and clients. Read the note about publishing the
   consent screen — it prevents refresh tokens expiring every 7 days.
3. **[docs/setup-apple.md](docs/setup-apple.md)** — generate the Xcode project, configure
   signing and capabilities, ship to TestFlight.

Day-to-day development uses the [`justfile`](justfile) (install `just` with
`brew install just`). Run `just --list` to see every recipe with a one-line
description. The common ones:

```bash
just install    # npm ci in all four packages
just check      # what the PR checks run: typecheck, lint, tests, mock eval
just eval       # live eval of production's models (costs under $1 a run)
```

Backend + web deploy automatically on merge to `main` (staging, then a prod
approval gate). The iOS app ships on an `ios-v*` tag (`just ship-ios`) via Xcode
Cloud → TestFlight. The whole pipeline is in [docs/ci-cd.md](docs/ci-cd.md). The
CDK deploy specifics and the local fallback (`just deploy <stage>`) are in
[docs/deploy.md](docs/deploy.md).

## The AI pipeline

Two Claude calls per capture, configured in `backend/src/lib/models.ts`:

1. **Classify** (`claude-haiku-5-5`, thinking off): is this an event poster / event
   screenshot / ticket / other content? Non-events skip calendar creation but stay
   in the library so the user can review them. The scrapbook search they were once
   kept for is parked.
2. **Extract** (`claude-sonnet-5`, thinking off, structured outputs): title, venue,
   address, dates, times, description, URL, price, category, confidence. The prompt
   is versioned. `backend/src/prompts/prompts.ts` pins the active version,
   `extract-event.v3.md`.

[ADR 0007](docs/decisions/0007-model-refresh-2026-10.md) records why these two
models and settings were chosen.

**Which model is good enough?** Run the eval harness — it scores each model
field-by-field against a labeled dataset and reports accuracy, hallucination rate,
latency, and cost per 100 images. See [evals/README.md](evals/README.md).

**Corrections make the prompt better.** The app stores each edit and keeps the
original extraction. A maintainer runs the prompt-improvement workflow by hand
([ADR 0006](docs/decisions/0006-prompt-improvement-manual-only.md)). It clusters
corrections into failure patterns, asks Claude to propose a minimal prompt change,
and opens a PR only if the eval gate passes. It reads only the owner's own
corrections, and only those made with eval consent on. A person reviews every
change. See [`tools/prompt-improvement/`](tools/prompt-improvement/README.md).

## Development & project hygiene

This repo is built to be a legible example of AI-assisted development.
[CONTRIBUTING.md](CONTRIBUTING.md) explains the working model: the three memory
tiers, where each kind of work lives, and how AI-authored change is kept safe (CI
gate, eval gate, prompt-improvement PR loop). In short:

- **Bugs / ideas** → GitHub Issues (`bug`, `enhancement`, `chore`, `docs`, `prompt-eval`).
- **Big reversible decisions** → [Architecture Decision Records](docs/decisions/).
- **Rules the AI must follow** → invariants in [CLAUDE.md](CLAUDE.md).

## Security posture

This repo is public so the app can be audited. What that means in practice:

- **Secrets are never in git.** Runtime secrets live in AWS SSM Parameter Store
  (SecureStrings under `/s2c/{stage}/…`), and local tooling reads them from the
  macOS Keychain — see [docs/secrets.md](docs/secrets.md). Refresh tokens are
  AES-256-GCM encrypted at rest.
- **Non-secret config is intentionally in source.** API endpoints, Google OAuth
  client IDs, the Apple Team ID, and the bundle ID all ship inside the released
  app and are extractable from any install, so committing them exposes nothing new.
  Auth (Google OAuth → app JWT) is the trust boundary, not endpoint obscurity.
- **Sign-up is invite-only.** A new account needs a Google email on the sign-up
  allowlist in Parameter Store, managed with `scripts/allowlist.sh`.
- **Deploy-time personal values are injected, not committed** — e.g. the ops alarm
  address comes from `ALERT_EMAIL` (env / CI variable), not `cdk.json`.
- **Sensitive internal design docs are kept untracked** until the weaknesses they
  describe are hardened.

## Privacy

Images and extracted data are stored encrypted at rest in eu-west-2 and used only to
provide the service. Evals and prompt improvement read only the owner's own data, and
only with eval consent on. Other users' data is never used for them, even with
opt-in. In-app: export all data, delete account (removes images, records, and revokes
Google access). Full policy: [docs/privacy-policy.md](docs/privacy-policy.md).
