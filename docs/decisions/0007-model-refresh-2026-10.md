# 0007. Haiku 5.5 for classification, Sonnet 5 extraction with thinking off

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Rhys + Claude Code

## Context

Claude Haiku 5.5 and Claude Sonnet 5.5 are newer than the pipeline's models
(Haiku 4.5 classifies, Sonnet 5 extracts, per [0001](0001-extraction-model-sonnet-5.md)).
The calls also sent no thinking or effort, so each model ran on its API
defaults. Sonnet 5 ran adaptive thinking at high effort, with that thinking
counted against the 1024 max_tokens of the extract call.

The rule set for the refresh: switch a stage only if its scores hold (no
field regression beyond noise, no new hallucinations) and cost or latency
improves. For each candidate, use the cheapest thinking setting that holds
quality.

Evidence: [`evals/reports/model-refresh-2026-10/`](../../evals/reports/model-refresh-2026-10/),
five live runs over `--dataset all` (76 cases, pinned prompts). Per-call
figures come from the runs' `claude_call` logs.

| Stage, model and setting | Key score | Halluc./case | $/call | Mean latency |
|---|---|---|---|---|
| Classify, Haiku 4.5 (before) | is_event 100%, category and is_event 68.4% | | $0.00155 | 0.87s |
| Classify, Haiku 5.5, thinking off, low effort | is_event 100%, category and is_event 88.2% | | $0.00017 | 1.26s |
| Extract, Sonnet 5, adaptive, high (before) | aggregate 98.3% | 0.11 | $0.00618 | 2.43s |
| Extract, Sonnet 5, thinking off, high | aggregate 98.5% | 0.11 | $0.00611 | 2.32s |
| Extract, Sonnet 5.5, between_tools, low | aggregate 99.0% | 0.08 | $0.00611 | 2.54s |
| Extract, Sonnet 5.5, between_tools, medium | aggregate 98.8% | 0.11 | $0.00611 | 2.77s |
| Extract, Haiku 5.5, thinking off, low | aggregate 96.4%, end_date 88.9% | 0.19 | $0.00031 | 1.89s |

## Decision

- Classify with `claude-haiku-5-5`, thinking disabled, effort low. is_event,
  the bit that gates processing, holds at 100%. The category is right far
  more often, and each call costs 89% less. Each call is about 0.4s slower,
  inside a background queue.
- Keep `claude-sonnet-5` for extraction, with thinking disabled at high
  effort. It scores the same as adaptive thinking (5 cases better, 3 worse,
  the same 8 hallucinated fields), is no dearer or slower, and leaves the
  whole max_tokens budget to the JSON.
- Do not adopt Sonnet 5.5 for extraction. Its gain (8 cases better, 4 worse,
  p ≈ 0.19) is inside run-to-run noise. Its price and token counts match
  Sonnet 5, so it cannot be cheaper, and it was slower at both efforts tried.
- Do not move extraction to Haiku 5.5. It misses end dates and hallucinates
  more.

## Consequences

- About 19% less per capture ($0.0077 to $0.0063), for about 0.3s more
  background time.
- The classify half of 0001 no longer holds. Its extract decision stands.
- `evals/reports/baseline/` still reflects July (prompt v2, Haiku 4.5
  classify, the old $3/$15 Sonnet price) until it is regenerated.
- Revisit Sonnet 5.5 if Sonnet 5 is deprecated or a run shows it faster.
  Revisit Haiku 5.5 for extraction after a prompt change aimed at run
  periods (end dates).
