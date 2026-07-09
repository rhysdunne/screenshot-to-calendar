<!-- One-line summary of what this changes and why. -->

## What


## Checklist
- [ ] `npm run typecheck` and `npm test` pass in the affected package(s)
- [ ] `CLAUDE.md` invariants respected (dates via `dates.ts`; pipeline purity; models via `models.ts`; secrets in Parameter Store; corrections never overwrite the original `event`)
- [ ] If a prompt changed: new version file + `ACTIVE_VERSIONS` bump + eval gate run, report attached
- [ ] If a non-obvious / reversible decision was made: ADR added under `docs/decisions/`
- [ ] If the API contract changed: `ios/Shared/Models.swift` and `docs/architecture.md` kept in sync

## Notes
<!-- Anything a reviewer should know: tradeoffs, follow-ups, out-of-scope. -->
