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
| A design not yet built | a design doc in `docs/` (e.g. `design-semantic-search.md`, now parked) |
| Routine commands (test, deploy, logs, eval, iOS release) | **[`justfile`](justfile)**: run `just --list` |

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

- **CI gate.** [`ci.yml`](.github/workflows/ci.yml) runs typecheck + tests on every
  PR across `backend`, `infra`, `evals`, and `tools/prompt-improvement`.
  [`ios.yml`](.github/workflows/ios.yml) compiles the iOS app without signing.
  `just check` runs the `ci.yml` steps locally.
- **Eval gate for prompt changes.** `tools/prompt-improvement` runs two fresh evals,
  the candidate prompt and the pinned one, and compares them **paired per case**. It
  does not compare against the committed baseline. A machine-proposed candidate must
  pass the strict sign-test gate
  ([ADR 0003](docs/decisions/0003-prompt-change-control.md)). The pairing exists
  because both arms run at API default temperature, and four runs of an identical
  prompt spanned 0.9pt. An absolute threshold on two independent means was inside
  its own noise floor. A human-written candidate cannot move enough cases to pass
  that test, so it runs the gate with `--report-only`, and the author reviews every
  changed case ([ADR 0008](docs/decisions/0008-human-written-prompt-review.md)).
- **Prompt-improvement PR loop.**
  [`prompt-improvement.yml`](.github/workflows/prompt-improvement.yml) proposes
  prompt changes from the owner's consented corrections (aggregate needs
  `OWNER_USER_ID`) and opens a PR. It never auto-merges. It runs on demand only,
  from the Actions tab
  ([ADR 0006](docs/decisions/0006-prompt-improvement-manual-only.md)).
- **Growing the real eval set is a manual step.** `cd tools/prompt-improvement &&
  OWNER_USER_ID=<your userId> npm run materialize` pulls the owner's consented
  corrections and their images out of prod into `evals/dataset/real/`. It reads no
  other account. Run it locally, **inspect the pixels** for third-party PII (faces,
  names, handles), redact, then commit. It is deliberately not in CI, because the
  repo is public and no automated step can do that review. The full command is in
  [`tools/prompt-improvement/README.md`](tools/prompt-improvement/README.md).
- **Deploy** — merge to `main` auto-deploys the backend + web to staging, then
  pauses at a prod approval gate ([`deploy.yml`](.github/workflows/deploy.yml));
  the iOS app ships on an `ios-v*` tag via Xcode Cloud. Full pipeline, gates, and
  release lanes: [docs/ci-cd.md](docs/ci-cd.md).

## Conventions

- **Commits:** imperative, sentence-case subjects ("Add …", "Fix …"). Not
  Conventional Commits.
- **Branches:** one change per branch, `kebab-case`.
- **PRs:** one per change; CI must pass; use the checklist in the PR template.
- **Naming:** kebab-case for files and directories unless a tool imposes otherwise.
- **iOS:** the Xcode project is generated from `ios/project.yml` by XcodeGen; the
  `.xcodeproj`, `Info.plist`, and entitlements are generated, not committed.

## Running it

Run `just --list` for the named commands. `just check` runs every PR check that
`ci.yml` runs, in all four packages. See [`SHIPPING.md`](SHIPPING.md) for
first-time setup. Per package: `cd <pkg> && npm test && npm run typecheck` for
`backend`, `infra`, `evals`, and `tools/prompt-improvement`.
