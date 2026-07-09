# 0003. Prompt change-control: versioned files, eval gate, PR review

- **Status:** Accepted
- **Date:** 2026-07-09 (records existing practice)
- **Deciders:** Rhys + Claude Code

## Context

Prompts are the behaviour of the AI pipeline. Editing a prompt in place would
silently change extraction results and invalidate eval baselines that reference it
by name. A poisoned user correction could otherwise degrade the prompt unnoticed.

## Decision

- Prompts are **versioned files** (`extract-event.v2.md`, `v3.md`, …). Never edit a
  version in place; create the next version.
- A single pin, `ACTIVE_VERSIONS` in `backend/src/prompts/prompts.ts`, selects the
  live version. Changing behaviour = new file + bump the pin.
- Every prompt change is **eval-gated**: `tools/prompt-improvement/run-gate.ts` runs
  the harness twice (candidate vs pinned) and fails on any per-field regression or
  no aggregate gain.
- The monthly `prompt-improvement` workflow proposes candidates from *consented*
  corrections and **opens a PR — never auto-merges**. A human reviews the diff, the
  gate report, and the correction clusters.

## Consequences

- Extraction behaviour is reproducible; every change is measured before it ships.
- Baselines stay valid because they reference immutable version files.
- Changing a prompt carries deliberate ceremony — appropriate for the riskiest,
  highest-leverage surface in the system.
