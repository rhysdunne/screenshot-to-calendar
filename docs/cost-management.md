# Cost management

A snapshot of the cost-management functionality in place across the three external
platforms the product depends on. The short version: cost is managed as **Anthropic
spend, observed after the fact** — good per-call instrumentation plus one notify-only
CloudWatch backstop. There are no hard spend caps anywhere, no per-user guards, and no
AWS or GCP billing tooling provisioned in code. This is deliberate at personal/TestFlight
volume; see [Known gaps](#known-gaps) for what a growth stage would need.

For the expected dollar figures see the [cost model in `architecture.md`](architecture.md#cost-model).

## Anthropic (Claude)

The only platform with real cost tracking. Every Claude call goes through the single
wrapper `callClaude` in `backend/src/lib/anthropic.ts`, which computes and records cost
as a side effect.

| Mechanism | Where | Notes |
|---|---|---|
| Per-call cost math | `backend/src/lib/models.ts` (`MODELS` + `costUsd()`) | Hardcoded $/M-token price table — the only place prices live. Unknown model → silently `$0`. |
| Structured log `claude_call` | `backend/src/lib/anthropic.ts` | stage, model, tokens, cost, latency, stopReason per call |
| EMF metric `AiCostUsd` | `backend/src/lib/anthropic.ts` | Namespace `s2c`, dimension `stage`. Emitted only when `STAGE` is set (Lambda, not evals). Backs the spend alarm. |
| `AICALL#<ulid>` telemetry item | `backend/src/lib/ddb.ts` (`putAiCall`) | Per-call record: tokens, cost, latency, model. 90-day TTL. **Write-only — never read or aggregated in code.** |
| Rolled-up `costUsd` on the capture | `backend/src/handlers/process-capture.ts` | classify + extract cost summed onto each `CAPTURE#` record |
| Spend alarm `s2c-ai-spend-{stage}` | `infra/lib/backend-stack.ts` | `AiCostUsd` summed over 24h > **$2** → SNS email. **Notify-only, account/stage-wide — does not throttle or cap.** |
| Offline `$/100 images` per model | `evals/src/harness.ts`, `evals/src/report.ts` | Eval harness reuses the production `costUsd()` path for model comparison |

To inspect spend ad hoc: query `AICALL#` items for a user, or read the `claude_call`
structured logs (see [`deploy.md`](deploy.md#operations)).

## AWS

Cost-conscious resource configuration plus the one guardrail above — but no billing
tooling as infrastructure-as-code.

**In place:**
- The `AiCostUsd` alarm above (an AWS alarm that happens to measure Anthropic spend).
- On-demand DynamoDB (`PAY_PER_REQUEST`), ARM64 Lambdas, 1-month CloudWatch Logs
  retention on every log group, S3 lifecycle rules (`exports/` expire 7d, `users/` →
  Infrequent Access at 90d), `AICALL#` TTL, and SQS `maxReceiveCount: 3` — all in
  `infra/lib/backend-stack.ts`.

**Not in place (absent from the CDK):** AWS Budgets, Cost Explorer, Cost Anomaly
Detection, `EstimatedCharges` billing alarms, CloudWatch cost dashboards,
cost-allocation tags, and Lambda reserved concurrency. A $10/month AWS Budget exists
only as a **manual CLI snippet** in [`setup-aws.md`](setup-aws.md), not as provisioned
infra.

## GCP

No cost or quota management — by design. Google is reached through thin `fetch` clients
(`backend/src/lib/google-auth.ts`, `google-calendar.ts`, `google-places.ts`); there is no
usage tracking, rate limiting/backoff, quota configuration, or alerting, and no
`AICALL#`-equivalent record. The stated posture is that Calendar API is free and Places
stays within its free tier at hobby volume ([`setup-google.md`](setup-google.md),
[`architecture.md`](architecture.md#cost-model)). The only documented Google-side limit
is the OAuth **verification** cap (100 users / 7-day refresh-token expiry in Testing
status) — an auth constraint, not a cost control.

## Known gaps

Recorded here for visibility; none are implemented. If prioritised, each should be filed
as a GitHub Issue (`enhancement`) per the work-tracking convention in
[`CLAUDE.md`](../CLAUDE.md).

- **No spend enforcement.** The $2 alarm only emails; nothing throttles, blocks, or caps.
  A user can submit unbounded captures — there is no per-user cost cap, per-user spend
  query, or spend-based circuit-breaker (the only per-user limit is the unrelated
  `DAILY_CORRECTION_LIMIT` in `captures-update.ts`).
- **`AICALL#` telemetry is written and expires unused** — no aggregation, rollup, or
  reporting reads it.
- **No prompt-cache accounting** in the cost math — `anthropic.ts` reads only
  `input_tokens`/`output_tokens`; `cache_creation`/`cache_read` tokens are ignored.
- **AWS billing tooling is not IaC** — no provisioned Budget, no cost-allocation tags, no
  reserved concurrency to bound runaway Lambda scaling.
- **No GCP-side usage/quota tracking.**
