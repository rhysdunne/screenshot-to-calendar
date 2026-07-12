# CI/CD pipeline

How change reaches production. Two independent lanes meet at `main`: the
**backend/web lane** (GitHub Actions → CDK → AWS) deploys automatically on merge;
the **iOS lane** (Xcode Cloud → TestFlight) ships on a tag. Neither can deploy
code that hasn't passed the PR gates first.

## The whole shape

```
        PR ──▶ required checks ──▶ merge to main
                (5 contexts)            │
                                        ├──▶ Deploy: CI ─▶ staging ─▶ [approve] ─▶ prod   (backend + web)
                                        │
        tag ios-v* ─▶ Release ─▶ Xcode Cloud archive ─▶ TestFlight            (iOS app)
```

## 1. PR gates (every pull request)

`main` is a protected branch (the `protect-main` ruleset, configured in the
GitHub UI — it is not in the tree). A PR cannot merge until five required status
checks pass, each the job id of a workflow:

- `backend`, `infra`, `evals`, `prompt-tools` — the four jobs in
  [`ci.yml`](../.github/workflows/ci.yml): typecheck, lint (backend), and the
  full mocked test suites. No AWS or API credentials; everything is stubbed.
- `ios-build` — [`ios.yml`](../.github/workflows/ios.yml): a compile-only check
  on a macOS runner, pinned to **Xcode 26.5 (17F42)** to match the Xcode Cloud
  release lane. No signing, no tests (there is no XCTest target yet). Separate
  from `ci.yml` so a backend deploy never waits on a macOS build.

## 2. Backend + web deploy (automatic on merge)

[`deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `main` (and
by manual dispatch). The pipeline is:

1. **CI** — reruns [`ci.yml`](../.github/workflows/ci.yml) via `workflow_call`, so
   `main` is verified once more before anything deploys.
2. **staging** — deploys `S2cWeb-staging` + `S2cBackend-staging` via
   [`deploy-stage.yml`](../.github/workflows/deploy-stage.yml) (a reusable
   single-stage job, GitHub OIDC → AWS role, no long-lived keys).
3. **prod** — the same reusable job for the `prod` stage, but gated behind a
   **required-reviewer rule on the `prod` environment**. The run pauses in the
   Actions UI until approved; an ignored gate expires after 30 days.

Prod can never receive a commit that didn't just deploy to staging. A docs-only
merge still redeploys staging — it's idempotent and keeps staging exactly at
`main`. To redeploy without a merge, dispatch **Deploy** and either approve the
prod gate (ship prod) or don't (staging only). Local `cdk deploy` remains
available as the manual fallback — see [deploy.md](deploy.md).

## 3. iOS release lane (Xcode Cloud → TestFlight, on a tag)

The iOS app is **not** deployed by GitHub Actions — signing is managed by Apple
in the cloud, and no certificates or Apple credentials touch this repo. Pushing
a tag matching `ios-v*` is what ships a build:

- [`release.yml`](../.github/workflows/release.yml) pairs every `ios-v*` tag with
  a GitHub Release (notes auto-generated from merged PRs) — the public shipping
  history. From a dev machine, `git tag ios-v… && git push` creates the release
  automatically; from a remote session that can't push tags, dispatching the
  **Release** workflow mints the tag instead.
- **Xcode Cloud** watches the repo via App Store Connect (not Actions), so the
  tag triggers the archive regardless of which token created it. It runs
  [`ci_post_clone.sh`](../ios/ci_scripts/ci_post_clone.sh) to generate the
  project with XcodeGen and stamp the build number, archives, and uploads to the
  TestFlight internal group.

Full setup and the reasoning behind the committed `Package.resolved`, the Xcode
version pin, and build-number stamping live in
[setup-xcode-cloud.md](setup-xcode-cloud.md).

## 4. Scheduled and dependency workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| [`eval-weekly.yml`](../.github/workflows/eval-weekly.yml) | Mondays 03:17 UTC + dispatch | Small live eval (~$0.10) so extraction-quality drift shows up week to week. |
| [`prompt-improvement.yml`](../.github/workflows/prompt-improvement.yml) | Monthly + dispatch | Clusters consented corrections, proposes a prompt revision, runs the eval gate, opens a PR. Never auto-merges. |
| [`dependabot.yml`](../.github/dependabot.yml) | Monthly | npm updates across the four packages (grouped: aws-sdk, dev-tooling) + GitHub Actions bumps. |

## Toolchain pins to keep in lockstep

Two places declare Xcode 26.5 (17F42) and must change together: the
`xcode-select` line in [`ios.yml`](../.github/workflows/ios.yml) and the Xcode
Cloud workflow's Environment setting. Pinning both keeps the PR compile gate and
the release archive on one toolchain. Bumping is a deliberate, paired act.
