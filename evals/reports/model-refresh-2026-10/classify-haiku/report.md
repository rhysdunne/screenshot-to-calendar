# Extraction eval report

- Dataset: `all`
- Prompt version: `pinned`
- Generated: 2026-10-12T12:14:31.270Z


## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | is_event | Errors | Mean latency | p95 latency | $/100 images |
|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-4-5 | **86.8%** | 0.82 | 0.06 | 68.4% | 100.0% | 0 | 2.9s | 3.8s | $0.40 |
| claude-haiku-5-5 | **96.4%** | 0.19 | 0.07 | 88.2% | 100.0% | 0 | 3.1s | 3.6s | $0.05 |

## Thinking settings

- claude-haiku-4-5 classify: thinking disabled, effort not sent, max 256 tokens
- claude-haiku-4-5 extract: thinking disabled, effort not sent, max 1024 tokens
- claude-haiku-5-5 classify: thinking disabled, effort low, max 256 tokens
- claude-haiku-5-5 extract: thinking disabled, effort low, max 1024 tokens

## Per-field accuracy

| Field | claude-haiku-4-5 | claude-haiku-5-5 |
|---|---|---|
| title | 94.4% | 99.3% |
| venue | 88.9% | 93.1% |
| address | 90.3% | 97.2% |
| start_date | 91.7% | 98.6% |
| end_date | 44.4% | 88.9% |
| start_time | 100.0% | 100.0% |
| end_time | 98.6% | 98.6% |
| url | 93.1% | 98.6% |

## Reading this report

- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here
  creates wrong calendar entries often enough to erode trust.
- **Halluc./case** counts fields invented where gold is null (worse than a
  miss: a made-up address sends you to the wrong place).
- **$/100 images** uses the price table in `backend/src/lib/models.ts`.
- **is_event** is the classify bit that gates processing; **Classify** also
  needs the category right, which nothing downstream uses yet.
