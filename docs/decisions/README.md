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

`Status` is one of `Accepted`, `Superseded by NNNN`, or `Deprecated`. Never edit the
Decision of an accepted ADR — supersede it with a new one and update the old
Status. (Same principle as the versioned prompt files; see ADR 0003.)

## Index

- [0001](0001-extraction-model-sonnet-5.md) — Sonnet 5 for event extraction
- [0002](0002-real-eval-dataset-labelling.md) — Real eval dataset labelling conventions
- [0003](0003-prompt-change-control.md) — Prompt change-control: versioned files + eval gate
- [0004](0004-content-moderation-at-ingest.md) — Content moderation at ingest via Rekognition
