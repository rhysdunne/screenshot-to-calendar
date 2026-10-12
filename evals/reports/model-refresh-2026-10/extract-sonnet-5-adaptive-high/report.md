# Extraction eval report

- Dataset: `all`
- Prompt version: `pinned`
- Generated: 2026-10-12T12:15:50.733Z


## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | is_event | Errors | Mean latency | p95 latency | $/100 images |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5 | **98.3%** | 0.11 | 0.00 | — | — | 0 | 2.3s | 3.3s | $0.59 |

## Thinking settings

- claude-sonnet-5 extract: thinking adaptive, effort high, max 1024 tokens

## Per-field accuracy

| Field | claude-sonnet-5 |
|---|---|
| title | 99.3% |
| venue | 98.6% |
| address | 94.4% |
| start_date | 95.8% |
| end_date | 100.0% |
| start_time | 100.0% |
| end_time | 100.0% |
| url | 98.6% |

## Reading this report

- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here
  creates wrong calendar entries often enough to erode trust.
- **Halluc./case** counts fields invented where gold is null (worse than a
  miss: a made-up address sends you to the wrong place).
- **$/100 images** uses the price table in `backend/src/lib/models.ts`.
- **is_event** is the classify bit that gates processing; **Classify** also
  needs the category right, which nothing downstream uses yet.
