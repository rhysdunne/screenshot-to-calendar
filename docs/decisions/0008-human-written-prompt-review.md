# 0008. Human-written prompt fixes are reviewed per case, not sign-test gated

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Rhys + Claude Code

## Context

Supersedes the gate rule of ADR 0003 for human-written candidates. The rest of
0003 stands.

[0003](0003-prompt-change-control.md) gates every prompt change with
`tools/prompt-improvement/src/run-gate.ts`. The gate pairs the candidate and the
pinned prompt on each case and passes only if all of these hold:

- no field drops by more than `FIELD_REGRESSION_TOLERANCE` (0.01),
- more cases improve than regress (`better > worse`), and a one-sided sign test
  gives p < 0.05,
- the mean aggregate does not drop, and hallucinations do not rise.

The gate was built for machine-proposed candidates. The prompt-improvement
workflow has a model write a candidate from user corrections, so the gate is
the poisoning defence that runs before any person reads the diff. Strict is
right there.

A human-written fix for a known failure cannot pass it. The smallest sign-test
pass is 5 cases improved and 0 regressed (p = 1/32 ≈ 0.031; 4 and 0 gives
0.0625, and 8 and 2 gives 0.055). A targeted fix such as #27 (just-passed dates
roll to the wrong year) changes one or two cases, so the gate rejects it by
construction. The field rule is just as tight: one binary field flipping in one
case of 78 scored cases moves that field by 1/78 ≈ 1.3pt, above the 1pt
tolerance. Noise flips cases on its own: four runs of one prompt spanned 0.9pt
(the comment in `run-gate.ts`), and two Sonnet 5 thinking settings with the
same score differed on 8 cases (5 better, 3 worse, [0007](0007-model-refresh-2026-10.md)).
A quality-neutral hardening change, such as #87, also fails the net-improvement
rule by construction.

Options considered:

- Loosen the gate for every candidate. This weakens the poisoning defence that
  machine-proposed candidates need.
- Add near-duplicate cases until a targeted fix moves five. This inflates the
  dataset and still leaves the decision to noise.
- Run the gate in report mode for human-written candidates and have the author
  review each changed case (chosen).

## Decision

- **Machine-proposed candidates** (`tools/prompt-improvement`, the
  `prompt-improvement` workflow) keep the strict paired sign-test gate of 0003,
  unchanged.
- **Human-written candidates** (a prompt version a person writes, or has a
  coding assistant write, in a PR) run the same gate in report mode:

  ```bash
  cd tools/prompt-improvement
  ANTHROPIC_API_KEY=... npm run gate -- --candidate v{N} --report-only
  ```

  This writes `gate.md` (the verdict, marked advisory) and `per-case.md` (every
  case that changed, with its field scores before and after). It exits 0 on
  PASS or FAIL, and still exits 2 when the comparison is unusable.
- The author adopts the candidate only if the per-case diff shows all of these:
  - the targeted cases are fixed,
  - no case loses a field,
  - every regression was re-run once to rule out noise, on both versions
    (the production extract model, and without `--prompt-version` for the
    pinned prompt):

    ```bash
    cd evals
    ANTHROPIC_API_KEY=... npm run eval -- --models claude-sonnet-5 --dataset all \
      --no-classify --prompt-version v{N} --cases <case-id>
    ```

    A regression that repeats blocks the candidate.
- The PR carries the gate summary, the per-case table and the re-runs, and the
  reports are committed under `evals/reports/`.
- The rest of 0003 holds: versioned prompt files, one pin, and human PR review.

## Consequences

- Targeted fixes can ship. `extract-event.v4` for #27 is the first to use
  report mode. Its review found a regression that repeats (an invented start
  time on `syn-009-gig`), so it is not pinned
  ([runs](../../evals/reports/prompt-v4-2026-10/)).
- The decision moves from a rule to a reviewer, so a careless review can pass a
  regression. The per-case table and the re-run rule keep each claim checkable,
  and the PR review checks them.
- Report mode never runs in CI, and `per-case.md` is never posted to the CI
  step summary, which is public. Real case ids from materialised corrections
  are `corr-<captureId>`, so the reports are committed only when the local
  dataset has no uncommitted `corr-*` cases.
- Revisit if the dataset grows enough for a targeted fix to move five cases, or
  if a change adopted this way later shows a regression the review missed.
