# 0006. Run prompt improvement on demand only

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Rhys + Claude Code

## Context

The prompt-improvement workflow
([`prompt-improvement.yml`](../../.github/workflows/prompt-improvement.yml)) ran on the
1st of each month. It aggregates consented corrections from prod, clusters them into
failure patterns, asks Claude for a candidate prompt, runs the eval gate and opens a PR
(see [`tools/prompt-improvement/README.md`](../../tools/prompt-improvement/README.md)).

It ran three times on the schedule, on 2026-08-01, 2026-09-01 and 2026-10-01, and failed
each time. Each failure was a workflow bug that has since been fixed. More important,
none of the runs had anything to work with: the aggregate step found **zero consented
corrections** in prod every time.

That will not change soon. A failure pattern is only eligible when corrections come from
**at least 3 independent captures** (`MIN_INDEPENDENT_CAPTURES` in `cluster.ts`, one of
the poisoning defences). Consent for eval use is off by default, and the app has one to
five users, mostly the developer. At that scale the loop cannot trigger. A monthly run
produced red builds and maintenance work, and no candidate prompts.

Two known gaps in the loop's poisoning defences are also still open:
[#46](https://github.com/rhysdunne/screenshot-to-calendar/issues/46) (correction values
reach the proposer LLM unsanitised) and
[#47](https://github.com/rhysdunne/screenshot-to-calendar/issues/47) (`materialize` has no
distinct-capture threshold). A loop that runs by itself on real user input should come
after those fixes, not before.

The live alternatives were:

- **Keep the schedule.** After the fixes, the no-candidate path should be a green no-op,
  so the runs would pass. But they would still assume a prod role and install
  dependencies every month to confirm that nothing is there.
- **Delete the workflow.** That throws away working, tested code that the product will
  need once real corrections exist.

## Decision

- **Remove the monthly schedule** from `prompt-improvement.yml`. Keep `workflow_dispatch`,
  so a maintainer can run the loop by hand from the Actions tab.
- **Keep the code and its tests.** The `prompt-tools` job in `ci.yml` still type-checks
  and tests `tools/prompt-improvement/` on every PR, so the code does not rot while the
  schedule is off.

This parks the automation in the same way as [ADR 0005](0005-park-ingest-moderation.md)
parked ingest moderation. The code stays ready, and the conditions to turn it back on are
written down.

## Consequences

- No more monthly red runs, and no monthly prod role assumption for a job with no input.
- Nothing reminds anyone that the loop exists, so consented corrections could build up
  unnoticed. The README and `docs/ci-cd.md` say how to run it by hand.
- **Re-enable only when all of these are true:**
  1. #46 and #47 are fixed.
  2. Prod has real consented corrections, and a manual run of `npm run aggregate` finds
     at least one eligible pattern.
  3. The PR that puts the schedule back adds a new ADR that marks this one *Superseded*.
