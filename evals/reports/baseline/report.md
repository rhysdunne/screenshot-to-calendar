# Extraction eval report

- Dataset: `all`
- Prompt version: `pinned`
- Generated: 2026-07-09T14:22:36.232Z


## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | p95 latency | $/100 images |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | **86.4%** | 0.51 | 1.00 | 67.1% | 8.7s | $0.37 |
| claude-sonnet-5 | **94.9%** | 0.13 | 0.96 | 82.9% | 12.6s | $1.29 |

## Per-field accuracy

| Field | claude-haiku-4-5 | claude-sonnet-5 |
|---|---|---|
| title | 91.0% | 98.6% |
| venue | 89.6% | 98.6% |
| address | 93.1% | 94.4% |
| start_date | 93.1% | 97.2% |
| end_date | 62.5% | 97.2% |
| start_time | 98.6% | 100.0% |
| end_time | 97.2% | 100.0% |
| url | 94.4% | 98.6% |

## Reading this report

- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here
  creates wrong calendar entries often enough to erode trust.
- **Halluc./case** counts fields invented where gold is null (worse than a
  miss: a made-up address sends you to the wrong place).
- **$/100 images** uses the price table in `backend/src/lib/models.ts`.
