# Evals

Answers the product question: **which Claude model is good enough to process
the images, and what does it cost?** — and gates every prompt change.

## Layout

| Path | What |
|---|---|
| `src/generate-posters.ts` | Synthetic poster generator (Playwright/Chromium). 8 event templates + a non-event "menu" template for the classifier. Gold labels are emitted from the same data object that fills the template, so ground truth is exact by construction. |
| `src/score.ts` | Field-level scoring: dates/times exact, title/venue fuzzy (reuses the production dedup similarity), addresses by postcode, URLs normalized. Nulls score three ways: match / hallucination / miss. |
| `src/harness.ts` | Runs each case through the **real production request path** (`backend/src/lib/anthropic.ts` + pinned prompts + `pipeline/extract.ts`) per model, concurrency 4. |
| `dataset/synthetic/` | Committed generated cases: `image.png` + `gold.json` + `meta.json`. `meta.frozenToday` pins `{{TODAY}}` so relative dates ("This Saturday") stay deterministic forever. |
| `dataset/real/` | Hand-labeled real screenshots — see `docs/adding-eval-images.md`. Only add images you have consent to use; the loader refuses a case without `"consent": true` in its `meta.json`. |
| `reports/` | Run outputs (gitignored except committed baselines). `model-refresh-2026-10/` holds the runs behind ADR 0007, force-added. |

## Commands

```bash
npm run generate -- --count 40 --seed 42          # regenerate synthetic dataset
npm test                                          # scoring + generator unit tests (no API key)
npm run eval -- --mock                            # plumbing check, no API calls

# The real thing. Each model runs both stages; over 76 cases that is about
# $0.75 for Sonnet 5 ($0.45 with --no-classify) and a few cents for Haiku 5.5:
ANTHROPIC_API_KEY=... npm run eval -- \
  --models claude-haiku-5-5,claude-sonnet-5 --dataset all

# Compare thinking settings: each flag replaces that field of the model's
# MODELS tuning for every stage the run calls (extract only here):
ANTHROPIC_API_KEY=... npm run eval -- --models claude-sonnet-5-5 --dataset all \
  --no-classify --thinking between_tools --effort medium

# Gate a candidate prompt version against the pinned one:
ANTHROPIC_API_KEY=... npm run eval -- --models claude-sonnet-5 --prompt-version v3
```

## Reading the report

- **Aggregate** — weighted field accuracy (dates ×2, title ×1.5). Below ~85%
  the product creates wrong calendar entries often enough to erode trust.
- **Halluc./case** — fields invented where the image showed nothing. A made-up
  address is worse than a missing one.
- **$/100 images** — from the price table in `backend/src/lib/models.ts`.

Pick the cheapest model whose aggregate and hallucination rate you can live
with; set it as `EXTRACT_MODEL` in the Lambda env (or change the default in
`backend/src/lib/models.ts`). A model needs an entry in `MODELS` with prices
and per-stage tuning (thinking, effort, max tokens) before any stage can use
it. The harness checks every model in `--models` against `MODELS` before the
first case runs, so a typo stops the run at no cost.

The CLI exits 1 when any case errors. Errors are caught per case so one bad
call does not sink a run, but a revoked key or a retired model errors every
case, and a scheduled run should go red when that happens.

## The eval gate

`tools/prompt-improvement/run-gate.ts` runs this harness twice (candidate
prompt vs pinned) and fails unless the candidate shows **no per-field
regression and an aggregate improvement** — the reason a poisoned correction
can't quietly degrade the prompt.
