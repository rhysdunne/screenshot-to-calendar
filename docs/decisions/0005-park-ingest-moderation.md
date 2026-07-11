# 0005. Park ingest moderation pending false-positive validation

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Rhys + Claude Code

## Context

ADR 0004 added a Rekognition moderation gate at ingest, and it shipped to `main`. On
reflection it should not run in production yet:

- **Current risk is low.** The app is on TestFlight with vetted users, so an unmoderated
  upload is low-stakes today — the pressure that motivated 0004 is not acute at this scale.
- **The false-positive rate is unmeasured.** Rekognition classifies image *pixels*, not
  topic, so the real exposure is legitimate event posters that genuinely contain nudity or
  strongly suggestive imagery (burlesque, life-drawing, body-positivity nights). Blocking
  those is the wrong call for this audience, and we have no live data on how often it would
  happen — the tests use fakes; live Rekognition has never run against a real image.
- **Taxonomy is unverified.** `MODERATION_BLOCK_CATEGORIES` is set to `Explicit Nudity`, but
  the account's Rekognition model may emit that as a sub-label under a top-level `Explicit`
  category, in which case the gate would silently never match. Untested.

We considered leaving the code in place behind `MODERATION_ENABLED=false`, but chose a clean
revert so production carries no dormant moderation code or `rekognition:*` IAM. Shadow-mode
(run-but-don't-block, to gather data) was deferred — worthwhile later, not needed at this size
now.

## Decision

- **Revert the 0004 implementation from `main`** (code, infra, tests, and the
  `@aws-sdk/client-rekognition` dependency). Production returns to storing uploads unmoderated.
- **Preserve the feature** on branch `parked/content-moderation-ingest` (the original commit
  `9a52bd9`; PR #49 is the historical reference) so it can be re-applied without redoing the work.
- **Keep 0004** as the record of what was built (Status → *Superseded by 0005*); this ADR
  records the decision to park it.

## Consequences

- Uploads are unmoderated again — accepted deliberately given the vetted-user base and low
  current risk.
- No dead moderation code or Rekognition IAM sits in production.
- **Re-integration path:** first run `aws rekognition detect-moderation-labels` against a real
  explicit image to confirm the correct top-level category string for the account's model;
  then cherry-pick `9a52bd9` (or revert this revert) onto a fresh branch, fix the category if
  needed, and strongly consider a **shadow-mode first pass** — run the gate non-blocking, log
  what it *would* have flagged — to measure the false-positive rate on real posters before
  enforcing.
- Revisit when the user base broadens beyond vetted testers, or if a concrete incident raises
  the risk.
