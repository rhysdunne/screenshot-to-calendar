# Baseline eval findings (2026-07-09)

First live baseline over `--dataset all` = 76 cases (44 synthetic + 32 real).
Models: `claude-haiku-4-5`, `claude-sonnet-5`, pinned prompts (extract v2, classify v1).
See `report.md` / `report.json` for the full numbers.

## Decision: keep Sonnet 5 for extraction

| Model | Aggregate | Halluc./case | end_date | $/100 (both stages) |
|---|---|---|---|---|
| claude-sonnet-5 | 94.9% | 0.13 | 97.2% | $1.29 |
| claude-haiku-4-5 | 86.4% | 0.51 | 62.5% | $0.37 |

Haiku clears the ~85% aggregate line but hallucinates ~4x as often (an invented
venue/address ~1 in 2 images) and is weak on exhibition run-periods (end_date
62.5%). For a product that writes calendar entries, hallucination is the worst
failure mode, so Sonnet stays the extraction default (`EXTRACT_MODEL` in
`backend/src/lib/models.ts`). The baseline validates the existing default rather
than changing it. ($/100 is each model doing both stages; production pairs
classify=Haiku + extract=Sonnet, so real per-capture cost is lower than the
Sonnet row.)

## Classifier gate is healthy

The report's classification accuracy (Haiku 67.1%, Sonnet 82.9%) is
`categoryCorrect && isEventCorrect`. Isolating the two on the 32 real cases
(Haiku):

- **`is_event`: 32/32 (100%)** — the bit that gates whether a capture is
  processed. Solid.
- **category: 16/32** — Haiku labels IG screenshots as `event_poster` where the
  gold (matching the `classify-image.v1` definition of "screenshot of an
  Instagram post/story") says `event_screenshot`. Cosmetic: the poster/screenshot
  split has no downstream effect until the scrapbook-categorisation feature
  exists.

## Prompt-improvement candidates (for a future prompt version, not fixed here)

1. **Just-passed dates roll to the wrong year.** `real-031-poster-the-invite-film`
   scored 0.70: "IN CINEMAS JULY 3" (no year), photographed 6 days later, and the
   prompt's "assume the next occurrence" rule pushed it to 2027 instead of 2026.
   Needs a recency carve-out (a date a few days in the past is almost certainly
   this year).
2. **Classify poster/screenshot bias** — the `classify-image` prompt could
   disambiguate an IG screenshot whose content is a poster. Low priority
   (scrapbook feature only).
