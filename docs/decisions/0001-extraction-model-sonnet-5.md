# 0001. Sonnet 5 for event extraction

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Rhys + Claude Code

## Context

The pipeline's extract stage reads an event out of a poster/screenshot. Model
choice trades accuracy against cost, and we wanted a defensible default measured
against the *real* input distribution, not a guess.

The first live eval baseline ran both candidates over 76 cases (44 synthetic + 32
real) with the pinned prompts. Evidence: [`evals/reports/baseline/`](../../evals/reports/baseline/)
(report + `FINDINGS.md`).

| Model | Aggregate | Halluc./case | end_date | $/100 (both stages) |
|---|---|---|---|---|
| claude-sonnet-5 | 94.9% | 0.13 | 97.2% | $1.29 |
| claude-haiku-4-5 | 86.4% | 0.51 | 62.5% | $0.37 |

## Decision

Use `claude-sonnet-5` for the extract stage (the default in
`backend/src/lib/models.ts`). Keep `claude-haiku-4-5` for the cheap classify stage
— its `is_event` accuracy is 100% on the real set (the lower combined classify
number is a cosmetic poster-vs-screenshot category bias, not a gating error).

## Consequences

- Higher per-extraction cost than Haiku, justified by ~4× fewer hallucinations —
  the worst failure mode for a product that writes calendar entries (an invented
  venue/address sends the user to the wrong place).
- This baseline is the regression reference the eval gate compares every future
  prompt/model change against.
- Revisit when a cheaper model clears the same bar on a re-run, or when cost
  becomes a constraint. Changing the default is a one-line edit in `models.ts` plus
  a re-run of the baseline.
