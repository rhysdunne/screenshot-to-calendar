# 0010. Run the iOS logic tests natively on macOS

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** Rhys + Claude Code

## Context

The iOS app had no test target, and the `ios-build` PR check only compiled it
([#125](https://github.com/rhysdunne/screenshot-to-calendar/issues/125)). The
Events list added pure date logic: it sorts captures into sections and formats
the "when" line, comparing `yyyy-MM-dd` strings with "today" in the user's
settings time zone. That logic deserves the same kind of tests as the
backend's `dates.ts` (DST days, the settings zone against the device zone,
invalid dates). It lives in two Foundation-only files,
`ios/App/EventSections.swift` and `ios/Shared/Models.swift`.

The options considered:

- **An unhosted bundle on the iOS simulator.** It runs the code on the iOS
  runtime the app uses. But every PR boots a simulator on the runner, and the
  destination names a simulator device and runtime, which runner image updates
  add and remove.
- **A bundle hosted in the app.** The tests run inside the launched app on a
  simulator. That builds the app and GoogleSignIn for the simulator, and runs
  the app's start-up code (which reads the session from the Keychain) before
  any test. It also needs a simulator, as the first option does.
- **A local Swift package** tested with `swift test`. The types the app uses
  would need `public` access, and the files would move out of `App/` and
  `Shared/`, which the app and the share extension compile today. `swift test`
  also runs on macOS, so its date strings would come from the macOS CLDR data
  as they do in the chosen option. It costs more restructuring for the same
  result.
- **An unhosted macOS bundle** that compiles the files under test directly
  (chosen).

## Decision

Implemented in [PR #128](https://github.com/rhysdunne/screenshot-to-calendar/pull/128):

- `ios/project.yml` adds `Screenshot2CalTests`, a `bundle.unit-test` for
  platform macOS (deployment target 14.0). Its sources are `ios/Tests/` plus
  `App/EventSections.swift` and `Shared/Models.swift`, so it has no host app,
  no simulator and no GoogleSignIn. It signs ad hoc, so Cmd-U on My Mac needs
  no certificate. The tests use Swift Testing.
- Its own scheme pins language `en`, region `GB` and `TZ=Pacific/Auckland`.
  The exact strings are en_GB, and a zone far from London makes a "today"
  taken from the device zone fail.
- [`ios.yml`](../../.github/workflows/ios.yml) runs it as a second step of the
  `ios-build` job, after the device compile, so the required check and the
  ruleset do not change. `just ios-test` runs the same command. The
  `Screenshot2Cal` scheme, which Xcode Cloud archives, does not build the
  tests.

## Consequences

- Fast and simple. On PR #128's CI run the test step took 35 s, and the 24
  tests themselves 0.2 s, next to 86 s for the device compile. Nothing launches
  and nothing boots.
- The tests found a real defect before merge: a lenient date parser showed the
  impossible date 2026-02-30 as "Mon 2 Mar".
- The date strings come from the CLDR data in the macOS that runs the tests,
  not from the iOS runtime. `runs-on: macos-26` follows the runner image's
  macOS updates, so a CLDR change can fail a PR that did not touch `ios/`.
  [`docs/ci-cd.md`](../ci-cd.md) says what to check first.
- The Foundation-only rule is only partly enforced. `import UIKit` or
  `import GoogleSignIn` in a listed file fails the test build, but
  `import SwiftUI` compiles on macOS, so review has to catch it. A file the
  tests need is added to the target's sources, and it must stay
  Foundation-only.
- The pinned zone has a blind spot: a display formatter that loses its GMT
  zone still passes, because GMT midnight is the same date in Auckland. A zone
  west of GMT would catch that but miss a wire-date parse taken from the
  device zone. The scheme comment records the trade-off.
- Views, `AppState` and the share extension have no tests. Check them on a
  device or simulator.
- Revisit if tests need UIKit, SwiftUI or the running app (for example
  `AppState` with a fake API client). Then add a simulator-hosted target
  beside this one, in a new ADR. Also revisit if macOS and iOS CLDR data drift
  apart enough to make the strings disagree, or if the tested logic grows
  enough for a Swift package to pay for itself.
