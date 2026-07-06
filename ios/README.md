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

Before building, replace the placeholders:

| Placeholder | Where | Value |
|---|---|---|
| `REPLACE_ME_TEAM_ID` | `project.yml` | Apple Developer Team ID |
| `REPLACE_ME_IOS_CLIENT_ID` / reversed | `project.yml` (Info properties) | iOS OAuth client from Google Cloud console |
| `REPLACE_ME_CLOUDFRONT_DOMAIN` | `project.yml` + `Shared/AppConfig.swift` | `WebDomain` output of the S2cWeb stack |
| `REPLACE_ME_PROD_API` / `REPLACE_ME_STAGING_API` | `Shared/AppConfig.swift` | `ApiUrl` outputs of the S2cBackend stacks |

## Structure

- `App/` — app target: sign-in (Google, calendar scope), onboarding calendar
  picker, capture library grid, editable capture detail (corrections),
  settings (calendar, consent toggle, export, delete account).
- `ShareExtension/` — receives an image from the share sheet, resizes to
  1000px/JPEG 0.8, uploads via a background URLSession scoped to the App
  Group, and dismisses. Requires the user to have signed in once in the app
  (the session token lives in the shared keychain access group).
- `Shared/` — API client, model mirrors of the backend contracts, keychain
  store, image resizer, config. Compiled into both targets.

Deep links: `https://<cloudfront-domain>/c/<captureId>` (from calendar event
descriptions) open the capture detail via Associated Domains.
