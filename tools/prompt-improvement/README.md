# Prompt improvement

Turns consented user corrections into a candidate extraction prompt, tests the
candidate against the eval dataset, and opens a PR if it passes. A person
always makes the final decision. Nothing here changes production by itself.

The loop is **manual-only** at the moment. See
[Why there is no schedule](#why-there-is-no-schedule).

## The four stages

| Stage | Script | Reads | Writes |
|---|---|---|---|
| aggregate | `src/aggregate-corrections.ts` | prod DynamoDB table | `work/patterns.json` |
| materialize | `src/materialize-eval-cases.ts` | prod DynamoDB table + images bucket | `evals/dataset/real/corr-<captureId>/` |
| propose | `src/propose-prompt.ts` | `work/patterns.json`, the active prompt | `backend/src/prompts/extract-event.v<N+1>.md`, `work/proposal.json` |
| gate | `src/run-gate.ts` | the eval dataset, both prompt versions | `evals/reports/gate-candidate-<v>/gate.md` and `gate.json` |

`work/` is gitignored. It holds intermediates only.

**aggregate** scans the prod table for `CORRECTION#` items where
`consentEvalUse` is true. It groups them by field and by kind of error: a miss
(the model gave null and the user filled the field in), a hallucination (the
model gave a value and the user cleared it), or a wrong value. A group becomes
an eligible failure pattern only if its corrections come from at least 3
different captures.

**materialize** turns consented, corrected captures into permanent eval cases.
The gold is the original extraction with the user's corrections applied. It
copies real user images into this public repo's working tree, so it is a
maintainer command. It never runs in CI. Look at every image, redact
third-party PII (faces, names, handles), then commit. It never overwrites an
existing case directory.

**propose** reads the patterns and asks Claude (`DEFAULT_MODELS.proposePrompt`
in `backend/src/lib/models.ts`) for the smallest prompt change that fixes them.
It writes the result as the next version file and records what it did in
`work/proposal.json`. It stops without calling Claude when there are no
patterns, or when an unmerged candidate above the active pin already exists
(`--force` overrides the second check). It refuses a proposal that drops the
`{{TODAY}}` placeholder.

**gate** decides whether the candidate is better. It runs the full eval dataset
(synthetic and real) twice on the production extract model: once with the
active prompt and once with the candidate. The classify stage is skipped,
because the candidate only changes the extract prompt. It then compares the two
runs case by case.

## Commands

Install first, from the repo root. These tools import source from `backend/`
and `evals/`, so all four packages need their dependencies:

```bash
just install
```

Then, from `tools/prompt-improvement/`:

```bash
# 1. Aggregate: needs AWS credentials that can Scan the prod table
AWS_PROFILE=<profile> TABLE_NAME=s2c-main-prod npm run aggregate

# 2. Propose: needs an Anthropic key
eval "$(../../scripts/secrets.sh env staging)"
npm run propose            # add -- --force to propose past a pending candidate

# 3. Gate the candidate that propose named in work/proposal.json
npm run gate -- --candidate v4              # optional: --model <model-id>

# Separately, to grow the real eval set (local only, check the pixels):
AWS_PROFILE=<profile> TABLE_NAME=s2c-main-prod BUCKET_NAME=s2c-images-<account>-prod npm run materialize
```

To run the same aggregate, propose, gate and PR sequence in CI, open the
Actions tab, choose **Prompt improvement**, then **Run workflow**. That
workflow never runs materialize.

A run that reaches the gate costs roughly $1.50: two runs of about 77 cases on
Sonnet 5 at about $0.008 per extract call, plus one proposal call. This is an
estimate from the per-image costs in `evals/reports/baseline/`. A run with no
patterns stops before any Claude call.

## Thresholds

| Rule | Value | Where |
|---|---|---|
| Distinct captures per failure pattern | at least 3 | `MIN_INDEPENDENT_CAPTURES`, `src/cluster.ts` |
| Largest allowed drop in any field's accuracy | 1 point | `FIELD_REGRESSION_TOLERANCE`, `src/run-gate.ts` |
| Cases improved vs regressed | more improved, with a one-sided sign test p < 0.05 | `SIGN_TEST_ALPHA` |
| Mean aggregate over the paired cases | must not drop | `compareReports` |
| Hallucinations per case | must not rise by more than 0.05 | `compareReports` |
| Cases scored on both sides | at least 95%, or the result is unusable | `MIN_PAIRED_COVERAGE` |
| Smallest per-case change that counts | 0.001 | `CASE_EPSILON` |

The gate exits 0 when the candidate passes, 1 when it rejects the candidate
(the mechanism working as designed), and 2 on misuse, a crash, or a comparison
with too many errors to trust.

## Safety rails

- **Consent only.** Only corrections with `consentEvalUse` true are read, and
  `cluster.ts` filters again. The consent flag is copied onto each correction
  when the user makes it.
- **Independent evidence.** One user editing one capture many times cannot
  create a pattern. A pattern needs corrections from 3 different captures.
- **Never auto-merges.** The workflow opens a PR. The candidate does not take
  effect until a person bumps `ACTIVE_VERSIONS` in
  `backend/src/prompts/prompts.ts` and merges.
- **Commit allowlist.** The PR step's `add-paths` names the new prompt file
  only. Reports, `work/` and dataset images are never committed.
- **Refuses un-reviewed real images.** If anything has changed under
  `evals/dataset/real/`, the workflow fails before it opens a PR.
- **Narrow CI credentials.** Dependencies install before AWS credentials
  exist. An inline session policy limits those credentials to a Scan of the
  prod table. The PR action is pinned to a commit SHA.

## Why there is no schedule

The workflow used to run monthly. All three scheduled runs failed, and prod had
zero consented corrections each time. A pattern needs corrections from at least
3 captures, so with one to five users the loop cannot trigger. The schedule was
removed in [ADR 0006](../../docs/decisions/0006-prompt-improvement-manual-only.md).

Before a schedule goes back:

1. Fix [#46](https://github.com/rhysdunne/screenshot-to-calendar/issues/46):
   correction values reach the proposer LLM unsanitised.
2. Fix [#47](https://github.com/rhysdunne/screenshot-to-calendar/issues/47):
   `materialize` has no distinct-capture threshold, so a single correction can
   become eval gold.
3. Confirm that real consented corrections exist: a manual aggregate run finds
   at least one eligible pattern.
4. Record the change in a new ADR that supersedes ADR 0006.
