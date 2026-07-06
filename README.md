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
                                                dedup    (fuzzy title + date window)
                                                create Google Calendar event
                                                  └─ description links back to the app
```

Everything runs in **eu-west-2** on the AWS free tier (Lambda + DynamoDB on-demand +
S3 + SQS + CloudFront). Steady-state cost is ≲ $2/month plus ~$0.01 of Anthropic
API per capture.

## Repository layout

| Directory | What it is |
|---|---|
| `backend/` | TypeScript Lambda application: handlers, pure pipeline functions, prompt files, AWS/Google/Anthropic clients. `npm test` runs the full suite. |
| `infra/` | AWS CDK app (TypeScript). `BackendStack` (DynamoDB, S3, SQS, Lambdas, HTTP API) + `WebStack` (CloudFront for universal links, privacy policy, capture fallback pages). |
| `evals/` | Eval harness for the AI pipeline: synthetic poster generator (Playwright), labeled dataset, field-level scoring, model comparison reports. |
| `tools/prompt-improvement/` | Offline pipeline that turns user corrections into candidate prompt changes, gated by the eval suite and human PR review. |
| `ios/` | Native SwiftUI app + Share Extension. Project generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml`. |
| `docs/` | Setup guides (AWS, Google Cloud, Apple), architecture notes, privacy policy, terms of service. |
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

Day-to-day development:

```bash
cd backend && npm ci && npm test        # backend unit + handler tests
cd infra   && npm ci && npm test        # CDK synth + assertions
cd evals   && npm ci && npm test        # scoring + generator tests
cd evals   && npm run generate          # regenerate synthetic eval posters
cd evals   && npm run eval -- --models claude-haiku-4-5   # live eval (needs ANTHROPIC_API_KEY)
```

Deployment is via GitHub Actions (`deploy.yml`, manual dispatch per stage) or locally
with `cd infra && npx cdk deploy` — see [docs/deploy.md](docs/deploy.md).

## The AI pipeline

Two Claude calls per capture, configured in `backend/src/lib/models.ts`:

1. **Classify** (`claude-haiku-4-5`): is this an event poster / event screenshot /
   ticket / other scrapbook content? Non-events are kept in the library but skip
   calendar creation — groundwork for the scrapbooking direction.
2. **Extract** (`claude-sonnet-5`, structured outputs): title, venue, address, dates,
   times, description, URL, confidence. Prompt lives in
   `backend/src/prompts/extract-event.v2.md` and is versioned — the active version is
   pinned in `backend/src/prompts/prompts.ts`.

**Which model is good enough?** Run the eval harness — it scores each model
field-by-field against a labeled dataset and reports accuracy, hallucination rate,
latency, and cost per 100 images. See [evals/README.md](evals/README.md).

**Corrections make the prompt better.** Edits made in the app are stored (original
extraction preserved) and a monthly job clusters them into failure patterns, asks
Claude to propose a minimal prompt change, and opens a PR — only if the eval suite
shows no regressions. Corrections only enter this pipeline from users who opted in,
and every change is human-reviewed. See `tools/prompt-improvement/`.

## Privacy

Images and extracted data are stored encrypted at rest in eu-west-2, used only to
provide the service, and never used for evals or prompt improvement without explicit
opt-in. In-app: export all data, delete account (removes images, records, and revokes
Google access). Full policy: [docs/privacy-policy.md](docs/privacy-policy.md).
