# CI/CD pipeline

How change reaches production. Two independent lanes meet at `main`: the
**backend/web lane** (GitHub Actions → CDK → AWS) deploys automatically when a
merge changes it; the **iOS lane** (Xcode Cloud → TestFlight) ships on a tag.
Neither can deploy code that hasn't passed the PR gates first.

## The whole shape

```
        PR ──▶ required checks ──▶ merge to main
                (5 contexts)            │
                                        ├──▶ Deploy: CI ─▶ staging ─▶ [approve] ─▶ prod   (backend + web)
                                        │
        tag ios-v* ─▶ Release ─▶ Xcode Cloud archive ─▶ TestFlight            (iOS app)
```

## 0. Local entry points (`just`)

The root [`justfile`](../justfile) gives every routine command a name. Run
`just` to list them with a one-line description each. The recipes copy what
the workflows do, so local runs and CI agree. When a workflow changes, change
the matching recipe in the same PR.

| Recipe | What it does | CI equivalent |
|---|---|---|
| `just install` | `npm ci` in backend, infra, evals and tools/prompt-improvement | the install steps in `ci.yml` |
| `just check` | install, then typecheck, lint, tests and the mock eval in every package | the four `ci.yml` jobs |
| `just ios-build` | XcodeGen, then an unsigned compile. Set `DEVELOPER_DIR` to use a different Xcode | `ios.yml`, first step |
| `just ios-test` | XcodeGen, then the iOS unit tests natively on this Mac. Set `DEVELOPER_DIR` to use a different Xcode | `ios.yml`, second step |
| `just deploy staging` | ALERT_EMAIL check, `cdk diff`, typed confirmation, `cdk deploy` of both stacks | `deploy-stage.yml` |
| `just logs prod processor` | follow one Lambda's CloudWatch logs | none |
| `just dlq prod` | count the messages on the dead-letter queue | none |
| `just eval` | live eval of production's models on the full dataset (about $0.85 a run) | none |
| `just ship-ios` | compute the next `ios-v*` tag, confirm, tag and push it | starts `release.yml` and Xcode Cloud |

## 1. PR gates (every pull request)

`main` is a protected branch (the `protect-main` ruleset, configured in the
GitHub UI — it is not in the tree). A PR cannot merge until five required status
checks pass, each the job id of a workflow:

- `backend`, `infra`, `evals`, `prompt-tools` — the four jobs in
  [`ci.yml`](../.github/workflows/ci.yml): typecheck, lint (backend), and the
  full mocked test suites. No AWS or API credentials; everything is stubbed.
  `just check` runs the same steps locally.
- `ios-build` — [`ios.yml`](../.github/workflows/ios.yml): on a macOS runner,
  pinned to **Xcode 26.6 (17F113)** to match the Xcode Cloud release lane. It
  compiles the app for a device, then runs the Swift Testing unit tests
  (`ios/Tests/`, scheme `Screenshot2CalTests`) natively on the runner's Mac,
  with no simulator. No signing. Separate from `ci.yml` so a backend deploy
  never waits on a macOS build. It has no `paths:` filter, so it runs on every
  PR. `just ios-build` and `just ios-test` run the two steps locally.

  The tests compare exact en_GB date strings such as "Sun 18 Oct". Those
  strings come from the CLDR data in the macOS that runs the tests, not from
  Xcode, and `runs-on: macos-26` takes the runner image's latest macOS 26
  update. If the test step fails on a PR that did not touch `ios/`, and only
  date strings differ, check the runner image's macOS version (the "Set up
  job" step logs it) before you change any code. The same CLDR change will
  reach users in an iOS release, so read the new strings before you update
  the expected ones. `just ios-test` follows your own Mac's macOS version in
  the same way.

## 2. Backend + web deploy (automatic on merge)

[`deploy.yml`](../.github/workflows/deploy.yml) runs on a push to `main` that
changes `backend/`, `infra/`, `.tool-versions` or the deploy workflows
(`deploy.yml`, `deploy-stage.yml`, `ci.yml`), and by manual dispatch. The
pipeline is:

1. **CI** — reruns [`ci.yml`](../.github/workflows/ci.yml) via `workflow_call`, so
   `main` is verified once more before anything deploys.
2. **staging** — deploys `S2cWeb-staging` + `S2cBackend-staging` via
   [`deploy-stage.yml`](../.github/workflows/deploy-stage.yml) (a reusable
   single-stage job, GitHub OIDC → AWS role, no long-lived keys).
3. **prod** — the same reusable job for the `prod` stage, but gated behind a
   **required-reviewer rule on the `prod` environment**. The run pauses in the
   Actions UI until approved; an ignored gate expires after 30 days.

The first step of every stage deploy checks that the `ALERT_EMAIL` repo variable
is set, and fails if it is empty. An empty value would still deploy, but the
stack then drops the SNS email subscription and the alarms notify nobody.
`just deploy` has the same check. To fix it locally, run
`export ALERT_EMAIL=$(gh variable get ALERT_EMAIL)`.

Prod can never receive a commit that didn't just deploy to staging. A merge that
only touches iOS, evals, tools or docs starts no Deploy run: the PR's required
checks already covered it, it deploys nothing, and each such run used to open a
prod gate that sat until it expired. To redeploy without a merge, dispatch
**Deploy** and either approve the prod gate (ship prod) or don't (staging only).
Local `just deploy <stage>` remains available as the manual fallback — see
[deploy.md](deploy.md).

## 3. iOS release lane (Xcode Cloud → TestFlight, on a tag)

The iOS app is **not** deployed by GitHub Actions — signing is managed by Apple
in the cloud, and no certificates or Apple credentials touch this repo. Pushing
a tag matching `ios-v*` is what ships a build:

- [`release.yml`](../.github/workflows/release.yml) pairs every `ios-v*` tag with
  a GitHub Release (notes auto-generated from merged PRs) — the public shipping
  history. From a dev machine, `just ship-ios` works out the next
  `ios-v<MARKETING_VERSION>-<N>` tag, asks you to type it, then tags `origin/main`
  and pushes. The release is created automatically. From a remote session that
  can't push tags, dispatching the **Release** workflow mints the tag instead.
- **Xcode Cloud** watches the repo via App Store Connect (not Actions), so the
  tag triggers the archive regardless of which token created it. It runs
  [`ci_post_clone.sh`](../ios/ci_scripts/ci_post_clone.sh) to generate the
  project with XcodeGen and stamp the build number, archives, and uploads to the
  TestFlight internal group.

TestFlight builds expire after 90 days. Ship a build at least every 80 days,
even with no app changes, so testers keep a working app.

Full setup and the reasoning behind the committed `Package.resolved`, the Xcode
version pin, and build-number stamping live in
[setup-xcode-cloud.md](setup-xcode-cloud.md).

## 4. Scheduled, manual and dependency workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| [`eval-weekly.yml`](../.github/workflows/eval-weekly.yml) | Mondays 03:17 UTC + dispatch | Live eval of 10 synthetic cases on production's classify and extract models (about $0.10 a run), so extraction-quality drift shows up week to week. |
| [`prompt-improvement.yml`](../.github/workflows/prompt-improvement.yml) | Manual dispatch only | Clusters the owner's consented corrections, proposes a prompt revision, runs the eval gate, opens a PR. Never auto-merges. |
| [`dependabot.yml`](../.github/dependabot.yml) | Monthly | npm updates across the four packages, plus GitHub Actions bumps. |

**Weekly eval.** The workflow reads the models from `DEFAULT_MODELS` in
`backend/src/lib/models.ts` at run time, so it always tests what production
runs. The harness uses one model for both stages, so read classification
accuracy from the classify model's row and extraction scores from the extract
model's row. The harness exits non-zero when any case hits an API error, so a
failed model call, such as a revoked key or a retired model, turns the run red.
The report is uploaded as an artifact either way.

**Prompt improvement** has no schedule
([ADR 0006](decisions/0006-prompt-improvement-manual-only.md)). The loop needs
corrections from at least 3 independent captures per failure pattern, and prod
had none on any of the three monthly runs. Put a schedule back only after #46
and #47 are fixed and real corrections exist. To run it, open Actions, choose
**Prompt improvement**, then **Run workflow**. The aggregate step reads only
the owner's account: a Query of the `OWNER_USER_ID` partition, never a Scan of
the table. Other users' corrections stay out even with consent, because the
job sends the values to Claude and pushes the candidate prompt to a public
branch. The workflow passes `OWNER_USER_ID` from a repository secret of that
name, so add the secret before the first run. It is a secret and not a
variable, so GitHub masks the value in the public logs. Without it, the step
stops with `Set OWNER_USER_ID`. An inline session policy limits the AWS
credentials the configure step creates to a Query of the prod table. That
narrows the normal path only: while the job holds `id-token: write`, any
step, an npm install script included, can request its own OIDC token and
assume the deploy role without the policy. A dedicated least-privilege role
is the real fix (#33). Stages and commands:
[`tools/prompt-improvement/README.md`](../tools/prompt-improvement/README.md).

**Dependabot** opens at most three grouped npm PRs a month: `cdk`,
`production` and `development`. Each holds minor and patch updates only. Every
major update arrives as its own PR. The `cdk` group keeps `aws-cdk`,
`aws-cdk-lib` and `constructs` in one PR, because the CDK CLI must be at least
as new as the library. Without it, the CLI (a dev dependency) and the library
(a production dependency) would land in separate PRs. New releases wait 7 days (`cooldown`) before Dependabot
proposes them. Two majors are ignored and bumped by hand:

- `typescript`: typescript-eslint 8.x declares TypeScript below 6.1 only, so
  TypeScript 7 would break `npm run lint`. Bump it when a typescript-eslint
  release supports the new major.
- `@types/node`: it follows the Lambda runtime (see the pins below).

GitHub Actions bumps arrive as one grouped PR.

Dependabot does not watch the iOS toolchain. The GoogleSignIn Swift package is
pinned by the committed `Package.resolved`; bump it by hand in Xcode (see
[setup-xcode-cloud.md](setup-xcode-cloud.md)). XcodeGen is not pinned at all:
`ios.yml` and `ci_post_clone.sh` install the latest Homebrew release on every
run, so a new XcodeGen release can change the generated project without a PR.

## Toolchain pins to keep in lockstep

**Xcode.** Two places declare Xcode 26.6 (17F113) and must change together: the
`xcode-select` line in [`ios.yml`](../.github/workflows/ios.yml) and the Xcode
Cloud workflow's Environment setting. Pinning both keeps the PR compile gate and
the release archive on one toolchain. Bumping is a deliberate, paired act.

**Node.** [`.tool-versions`](../.tool-versions) holds the Node major (`nodejs 22`)
once. Every `actions/setup-node` step reads it through `node-version-file`, and
mise or asdf read it locally. Production runs on the Lambda runtime, so these
must move together, in one PR:

1. `.tool-versions` (CI and local Node).
2. `lambda.Runtime.NODEJS_22_X` and the esbuild `target: 'node22'` in
   [`infra/lib/backend-stack.ts`](../infra/lib/backend-stack.ts).
3. `@types/node` in all four `package.json` files
   (`npm install --save-dev @types/node@^<major>` in each package), so code
   cannot type-check against Node APIs the Lambda runtime lacks.

Bump to a new major only once AWS offers it as a Lambda runtime.
