# Xcode Cloud → TestFlight

Xcode Cloud archives the app and uploads to TestFlight, with signing managed by
Apple in the cloud — no certificates, profiles, or Apple credentials ever touch
this repo or GitHub Actions. It complements CI: `ios.yml` (GitHub Actions) is the
fast per-PR compile gate; Xcode Cloud is the release lane.

## How this repo supports it

- [`ios/ci_scripts/ci_post_clone.sh`](../ios/ci_scripts/ci_post_clone.sh) runs on
  every cloud build before Xcode resolves the project: installs XcodeGen,
  generates `Screenshot2Cal.xcodeproj` (none is committed), and stamps
  `CURRENT_PROJECT_VERSION` with Xcode Cloud's monotonically increasing
  `CI_BUILD_NUMBER` so TestFlight never sees a duplicate build number.
  `MARKETING_VERSION` (the user-facing x.y.z) stays hand-managed in
  `ios/project.yml`.

## One-time setup (Xcode UI, personal Apple ID)

1. `cd ios && xcodegen generate && open Screenshot2Cal.xcodeproj`
2. Product → Xcode Cloud → Create Workflow; sign in.
3. Grant repo access: only `rhysdunne/screenshot-to-calendar` needs the green
   tick. **Ignore the `google/*` package repos in the grant screen** — App Store
   Connect asks you to install its GitHub App on the `google` org, which only a
   Google org owner could do. Grants are for *private* repos; public package
   dependencies are fetched anonymously. Close that page and click Next.
4. Workflow settings:
   - Environment: latest Xcode 16.x (project pins `xcodeVersion: 16.0`).
   - Start condition: **Tag** matching `ios-v*` (delete the default branch
     condition — most merges to main are backend-only and shouldn't burn
     compute hours on an archive nobody installs).
   - Archive action: scheme `Screenshot2Cal`, platform iOS.
   - Post-action: TestFlight Internal Testing → the internal tester group.
5. First build: start it manually from Xcode (or push a test tag). Cloud
   signing creates its certificates against the existing app record on first
   run — any surprise will surface here; the rest is deterministic.

## Shipping a TestFlight build

```bash
git tag ios-v1.0.0-3   # convention: ios-v<MARKETING_VERSION>-<attempt>
git push origin ios-v1.0.0-3
```

The tag is the audit trail of what shipped. Build numbers are automatic
(`CI_BUILD_NUMBER`); bump `MARKETING_VERSION` in `ios/project.yml` when the
user-facing version changes.

## Costs

25 free compute hours/month with the developer membership; an archive build is
roughly 15 minutes, so the free tier covers ~100 builds/month — not a real
constraint at this cadence.
