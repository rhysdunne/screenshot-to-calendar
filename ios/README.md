# iOS app

Native SwiftUI app + Share Extension. The Xcode project is **generated** from
`project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen) — no
`.xcodeproj` is committed. Full build/signing/TestFlight walkthrough:
[docs/setup-apple.md](../docs/setup-apple.md).

```bash
brew install xcodegen
cd ios
xcodegen generate
open Screenshot2Cal.xcodeproj
```

From the repo root, `just ios-build` runs the same unsigned compile as the
`ios-build` PR check, and `just ios-test` runs the same unit tests. In Xcode,
choose the Screenshot2CalTests scheme with My Mac as the destination, then
press Cmd-U.

## Committed configuration

A fresh checkout builds as it is. `project.yml` and `Shared/AppConfig.swift`
hold this app's real values. None of them is secret: they ship inside the app,
so anyone can read them from an install. The comment at the top of
`AppConfig.swift` says the same.

A fork that deploys its own backend replaces these values:

| Value | Where | Source |
|---|---|---|
| `DEVELOPMENT_TEAM` | `project.yml` | Apple Developer Team ID |
| `GIDClientID` and the reversed client id URL scheme | `project.yml` (Info properties) | iOS OAuth client from the Google Cloud console |
| `GIDServerClientID` | `project.yml` (Info properties) | web OAuth client id, the same as `googleClientId` in `infra/cdk.json` |
| `applinks:` domain and `webDomain` | `project.yml` + `Shared/AppConfig.swift` | `WebDomain` output of the S2cWeb stack |
| `prodApiBase` / `stagingApiBase` | `Shared/AppConfig.swift` | `ApiUrl` outputs of the S2cBackend stacks |
| `supportEmail` | `Shared/AppConfig.swift` | the controller contact named in `privacy.html` |

The bundle ids, the App Group and the keychain group (`digital.callaeas.s2c…`)
are registered to this Apple team. A fork also renames them in `project.yml`,
`Shared/AppConfig.swift` and `infra/cdk.json` (`iosBundleId`).

## Structure

- `App/`: the app target. It has sign-in (Google, calendar scope), an
  onboarding calendar picker that also saves the device's timezone, and the
  Events list, which sorts captures by event date (`EventSections.swift`). It
  also has the editable capture detail (corrections, and approve for a capture
  that needs review) and settings (calendar, timezone, consent toggle, export,
  delete account).
- `ShareExtension/`: receives an image from the share sheet and resizes it to
  1000px/JPEG 0.8. A file or data item is downsampled with ImageIO, so the
  full-size image is never decoded. The extension then uploads through a
  background URLSession scoped to the App Group and dismisses. It needs a
  session from the app (the token lives in the shared keychain access group).
  It refuses a share when the session has expired or expires within the hour,
  and the app signs out at the same point. Upload bodies live in the App Group
  container. The extension sweeps them after 24 hours, and the app deletes them
  on sign-out.
- `Shared/`: compiled into both targets. It holds the API client, model
  mirrors of the backend contracts, the keychain store, the image resizer and
  config. It also holds `SessionToken.swift`, which reads the session JWT's
  expiry, and `UploadBodyStore.swift`, which writes, sweeps and deletes upload
  bodies.
- `Tests/`: Swift Testing unit tests for the Foundation-only logic
  (`EventSections.swift`, `ImageViewerGeometry.swift` and `Models.swift`). The
  Screenshot2CalTests target compiles those three files straight in and runs
  on the Mac, with no host app or simulator, so it cannot test views or
  `AppState`. To test another file,
  add it to the target's sources in `project.yml`. That file must stay
  Foundation-only: `import UIKit` or `import GoogleSignIn` fails the test
  build, but `import SwiftUI` compiles on macOS, so review has to catch it.
  The scheme pins en_GB and `TZ=Pacific/Auckland`, so the exact date strings
  are stable and a "today" from the device zone fails.

Deep links: `https://<cloudfront-domain>/c/<captureId>` (from calendar event
descriptions) open the capture detail via Associated Domains.
