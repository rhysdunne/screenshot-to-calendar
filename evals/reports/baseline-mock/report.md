# Extraction eval report

- Dataset: `synthetic`
- Prompt version: `pinned`
- Generated: 2026-07-06T15:04:25.724Z
- ⚠️ MOCK RUN (no API calls — plumbing check only)

## Summary

| Model | Aggregate | Halluc./case | Miss/case | Classify | p95 latency | $/100 images |
|---|---|---|---|---|---|---|
| claude-haiku-4-5 | **100.0%** | 0.00 | 0.00 | 100.0% | 0.0s | $0.00 |

## Per-field accuracy

| Field | claude-haiku-4-5 |
|---|---|
| title | 100.0% |
| venue | 100.0% |
| address | 100.0% |
| start_date | 100.0% |
| end_date | 100.0% |
| start_time | 100.0% |
| end_time | 100.0% |
| url | 100.0% |

## Reading this report

- **Aggregate** weights dates ×2 and title ×1.5 — a model below ~85% here
  creates wrong calendar entries often enough to erode trust.
- **Halluc./case** counts fields invented where gold is null (worse than a
  miss: a made-up address sends you to the wrong place).
- **$/100 images** uses the price table in `backend/src/lib/models.ts`.
