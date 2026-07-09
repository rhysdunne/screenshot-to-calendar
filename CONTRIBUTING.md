# Contributing / How this repo works

This is a solo, AI-assisted project, built to be legible. A human (Rhys) and an AI
coding agent (Claude Code) develop it together — and the same model family also runs
*inside* the product (the Claude vision pipeline). This doc explains how work,
memory, and decisions are organised so both a returning human and a fresh AI session
can pick up without archaeology.

## Where things live

| Kind of thing | Home |
|---|---|
| Hard rules the AI must always follow | **[`CLAUDE.md`](CLAUDE.md)** — invariants, each with the *reason* attached |
| Big, reversible decisions ("why is it like this?") | **[`docs/decisions/`](docs/decisions/)** — ADRs |
| Bugs, ideas, known issues | **GitHub Issues** — labels `bug`, `enhancement`, `chore`, `docs`, `prompt-eval` |
| The ordered first-deploy runbook | **[`SHIPPING.md`](SHIPPING.md)** |
| Setup walkthroughs, architecture, policies | **[`docs/`](docs/)** |
| A design not yet built | a design doc in `docs/` (e.g. `design-semantic-search.md`) |

**Rule of thumb.** Notice an out-of-scope bug → **file an issue**. Make a
non-obvious reversible call → **write an ADR**. Establish a rule the AI must always
obey → **add a `CLAUDE.md` invariant**.

## The three memory tiers (for AI-assisted work)

1. **`CLAUDE.md`** — committed to the repo, read by every AI session, shared with
   humans. The durable rulebook.
2. **Local auto-memory** (`~/.claude/projects/<repo>/memory/`) — the AI's
   cross-session scratchpad (project state, preferences). **Not in the repo**;
   personal to the machine.
3. **Plan files** — ephemeral working docs for a single task. Not a durable record;
   anything worth keeping graduates to an ADR or a `CLAUDE.md` invariant.

## How AI-authored change is kept safe

- **CI gate** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — typecheck +
  tests on every PR across `backend`, `infra`, `evals`, and `tools/prompt-improvement`.
- **Eval baseline + gate** — `evals/` scores extraction against a committed baseline
  (`evals/reports/baseline/`); no prompt change ships without passing the gate
  against it. See [ADR 0003](docs/decisions/0003-prompt-change-control.md).
- **Prompt-improvement PR loop**
  ([`.github/workflows/prompt-improvement.yml`](.github/workflows/prompt-improvement.yml))
  — proposes prompt changes from consented corrections and opens a PR; never
  auto-merges.
- **Deploy** is manual (`workflow_dispatch`, OIDC) per stage.

## Conventions

- **Commits:** imperative, sentence-case subjects ("Add …", "Fix …"). Not
  Conventional Commits.
- **Branches:** one change per branch, `kebab-case`.
- **PRs:** one per change; CI must pass; use the checklist in the PR template.
- **Naming:** kebab-case for files and directories unless a tool imposes otherwise.
- **iOS:** the Xcode project is generated from `ios/project.yml` by XcodeGen; the
  `.xcodeproj`, `Info.plist`, and entitlements are generated, not committed.

## Running it

See [`README.md`](README.md) for commands and [`SHIPPING.md`](SHIPPING.md) for
first-time setup. Per package: `cd <pkg> && npm test && npm run typecheck` for
`backend`, `infra`, `evals`, and `tools/prompt-improvement`.
