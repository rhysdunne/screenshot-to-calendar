# Prompt gate: candidate v4 (claude-sonnet-5)

Report mode (ADR 0008): the verdict below is advisory. The author reviews
the per-case changes in per-case.md.

Baseline aggregate: 98.0%
Candidate aggregate: 98.8%

Paired cases: 78
- improved: 5
- regressed: 3
- unchanged: 70
- sign test p = 0.3633 (α = 0.05)

Classification stage excluded — the candidate only changes `extract-event`.

## ❌ FAIL
- improvement is within noise: 5 better / 3 worse, sign test p=0.363 (need p<0.05)