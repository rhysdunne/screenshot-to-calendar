# Architecture Decision Records (ADRs)

One-page records of **big, reversible, likely-to-be-relitigated** decisions — the
"why" behind bets a future contributor (human or AI) might otherwise re-open or
accidentally undo.

## When to write one

Write an ADR when a decision is **all three of**:

- **Reversible but costly to change** — a model choice, a data convention, a storage shape.
- **Non-obvious** — the reasoning isn't self-evident from the code.
- **Likely to be questioned** — someone will ask "why is it like this?"

Do **not** write an ADR for:

- Hard rules the AI must always follow → those are **invariants in [`CLAUDE.md`](../../CLAUDE.md)**.
- One-off implementation details → a commit message or code comment.
- Setup steps → [`SHIPPING.md`](../../SHIPPING.md) / the `docs/` guides.

## Format

Copy [`_template.md`](_template.md) → `NNNN-kebab-title.md` (zero-padded, next number).
Keep it to a page: Status / Context / Decision / Consequences. **Link** evidence
(eval reports, benchmarks) rather than pasting it.

## Lifecycle

`Status` is one of `Accepted`, `Partly superseded by NNNN (<the part>)`,
`Superseded by NNNN`, or `Deprecated`. Never edit the Decision of an accepted ADR.
Supersede it with a new one and update the old Status. This is the same
principle as the versioned prompt files (see ADR 0003).

Use `Partly superseded` when a new ADR replaces only part of an old decision.
The rest of the old decision still holds. A short note after it can point to a
later ADR that changed a detail. The Status line is the only line you edit in
the old ADR.

## Index

- [0001](0001-extraction-model-sonnet-5.md): Sonnet 5 for event extraction (partly superseded by 0007 for the classify model)
- [0002](0002-real-eval-dataset-labelling.md): Real eval dataset labelling conventions
- [0003](0003-prompt-change-control.md): Prompt change-control: versioned files + eval gate (partly superseded by 0008 for human-written candidates)
- [0004](0004-content-moderation-at-ingest.md): Content moderation at ingest via Rekognition (superseded by 0005)
- [0005](0005-park-ingest-moderation.md): Park ingest moderation pending false-positive validation
- [0006](0006-prompt-improvement-manual-only.md): Run prompt improvement on demand only
- [0007](0007-model-refresh-2026-10.md): Haiku 5.5 for classification, Sonnet 5 extraction with thinking off
- [0008](0008-human-written-prompt-review.md): Human-written prompt fixes are reviewed per case, not sign-test gated
- [0009](0009-stalled-captures-derived-at-read-time.md): Report stalled captures as failed at read time
