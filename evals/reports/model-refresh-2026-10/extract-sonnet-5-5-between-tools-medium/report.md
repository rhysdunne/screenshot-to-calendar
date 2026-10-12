# Extraction eval report

- Dataset: `all`
- Prompt version: `pinned`
- Generated: 2026-10-12T12:19:45.776Z


## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | is_event | Errors | Mean latency | p95 latency | $/100 images |
|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | **98.8%** | 0.11 | 0.00 | — | — | 0 | 2.6s | 4.0s | $0.58 |

## Thinking settings

- claude-sonnet-5-5 extract: thinking between_tools, effort medium, max 1024 tokens

## Per-field accuracy

| Field | claude-sonnet-5-5 |
|---|---|
| title | 100.0% |
| venue | 98.6% |
| address | 93.1% |
| start_date | 100.0% |
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
