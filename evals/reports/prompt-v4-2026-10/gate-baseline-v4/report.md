# Extraction eval report

- Dataset: `all`
- Prompt version: `pinned`
- Generated: 2026-10-12T14:30:25.593Z


## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | is_event | Errors | Mean latency | p95 latency | $/100 images |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5 | **98.0%** | 0.09 | 0.00 | — | — | 0 | 2.2s | 2.9s | $0.58 |

## Thinking settings

- claude-sonnet-5 extract: thinking disabled, effort high, max 1024 tokens

## Per-field accuracy

| Field | claude-sonnet-5 |
|---|---|
| title | 100.0% |
| venue | 98.7% |
| address | 93.6% |
| start_date | 94.9% |
| end_date | 98.7% |
| start_time | 100.0% |
| end_time | 100.0% |
| url | 100.0% |

## Reading this report

- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here
  creates wrong calendar entries often enough to erode trust.
- **Halluc./case** counts fields invented where gold is null (worse than a
  miss: a made-up address sends you to the wrong place).
- **$/100 images** uses the price table in `backend/src/lib/models.ts`.
- **is_event** is the classify bit that gates processing; **Classify** also
  needs the category right, which nothing downstream uses yet.
