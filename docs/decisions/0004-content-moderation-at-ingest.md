# 0004. Content moderation at ingest via Rekognition

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Rhys + Claude Code

## Context

The app accepts arbitrary user-uploaded images and, until now, wrote every one to S3
(`captures-create.ts`) *before* any model inspected it — and even a `not_event` capture
is retained indefinitely. So an accidental or deliberate explicit/illegal upload landed
in the bucket unchecked, with no detection, takedown path, or evidence of reasonable
steps. For a live, published (TestFlight) app taking user content this is a real legal and
reputational exposure: UK possession law, the Online Safety Act 2023's illegal-content
duties, and the AWS Acceptable Use Policy all point the same way.

The alternatives considered: (a) moderate in the async processor (`process-capture`), which
already reads the image — cheaper to wire, but the image has already been persisted by
then, which defeats the point; (b) moderate at ingest before persistence — slightly more
work and couples upload latency/availability to a second service, but nothing unchecked
ever hits the bucket. We chose (b).

## Decision

- Call Rekognition `DetectModerationLabels` at ingest, **before the S3 put and before any
  DynamoDB write**, on JPEG/PNG uploads. The decision logic is a pure function
  (`pipeline/moderation.ts`); the client is a thin wrapper (`lib/rekognition.ts`) — the
  same I/O-returns-data / pipeline-decides split as `anthropic.ts` → `pipeline/extract.ts`.
- Block when a configured top-level category (default: `Explicit Nudity`) meets or exceeds
  a confidence threshold (default 80%). Blocked → **HTTP 422, nothing persisted** (no S3
  object, no hash claim, no capture record, no queue message). No new `CaptureStatus` and
  no iOS contract change follow from this.
- **Fail closed.** If moderation cannot run — a Rekognition error/outage (503) or an
  unmoderatable format such as GIF/WebP that Rekognition can't inspect (415) — the upload
  is refused, never stored unchecked. The client only ever sends resized JPEG, so 415 is an
  edge case in practice.
- Category set, threshold, and an enable flag are env-configured (`MODERATION_ENABLED`,
  `MODERATION_MIN_CONFIDENCE`, `MODERATION_BLOCK_CATEGORIES`) so tuning needs no code change.
  The enable flag doubles as a local-dev kill switch, since fail-closed would otherwise
  block uploads anywhere Rekognition is unreachable.
- This is an **adult-content** control. It is explicitly **not** a CSAM control — that needs
  perceptual-hash matching (PhotoDNA / IWF hash lists) and a proper legal review of Online
  Safety Act scope for a service this size, both tracked as separate follow-up issues.

## Consequences

- Strengthens the "reasonable steps" posture and gives a documented, dated control rather
  than an implicit gap. The honest scoping (adult-content, not CSAM) is deliberate.
- Couples upload availability to Rekognition: a Rekognition outage refuses uploads (503).
  Accepted on purpose over the alternative of storing unchecked content during an outage.
- Adds ~100–300ms and ~$0.001/upload — negligible, and likely inside the 12-month free tier
  at current volume.
- Residual gaps remain — CSAM-specific detection and the indefinite-retention of stored
  images (no expiry lifecycle) — see the follow-up issues.
- Revisit when the scrapbook direction broadens accepted formats (GIF/WebP would need a
  pre-convert step), or if Online Safety Act scope for a service this size is clarified.
