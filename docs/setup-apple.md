# Apple / Xcode / TestFlight setup

Prereqs: a Mac with Xcode 16+, an Apple Developer Program membership
($99/year), and the AWS + Google setup done (you need the CloudFront domain,
API URLs, and OAuth client ids).

## 1. Generate the project

```bash
brew install xcodegen
cd ios
```

Replace the placeholders first (see the table in `ios/README.md`):

- `project.yml`: `DEVELOPMENT_TEAM`, `GIDClientID`, `GIDServerClientID`,
  reversed client id URL scheme, `applinks:` domain.
- `Shared/AppConfig.swift`: API URLs and `webDomain`.

Then:

```bash
xcodegen generate
open Screenshot2Cal.xcodeproj
```

Xcode resolves the GoogleSignIn Swift package on first open.

## 2. Signing & capabilities

With Automatic signing and your team selected, Xcode registers both bundle
ids (`digital.callaeas.s2c`, `digital.callaeas.s2c.share`) and provisions the
capabilities declared in the entitlements files:

- **App Groups**: `group.digital.callaeas.s2c` (both targets)
- **Associated Domains**: `applinks:<cloudfront-domain>` (app target)
- **Keychain Sharing**: `digital.callaeas.s2c.shared` (both targets)

If the Associated Domains capability errors, enable it for the App ID in
[developer.apple.com](https://developer.apple.com/account/resources/identifiers)
and let Xcode retry.

## 3. First run on your device

1. Select your iPhone as the destination, Run.
2. Sign in with Google (expect the "unverified app" warning — Continue).
3. Create/pick a calendar in onboarding.
4. Share any event poster from Photos → **Capture Event** → back in the app,
   watch the capture complete → check Google Calendar.
5. Tap the "View capture" link in the calendar event → the app should open
   the capture (universal link). If Safari opens instead: universal links
   cache aggressively — reinstall the app, or check
   `https://<domain>/.well-known/apple-app-site-association` is reachable and
   contains your `TEAMID.digital.callaeas.s2c`.

## 4. TestFlight

Builds reach TestFlight through the **Xcode Cloud release lane**, not a manual
archive — set it up once (post-clone hook, repo access, Xcode version pin,
TestFlight post-action) following
[setup-xcode-cloud.md](setup-xcode-cloud.md). One-time app-record steps:

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com): create the
   app record (same bundle id) if it doesn't exist yet.
2. TestFlight tab → add yourself to an **Internal Testing** group. Internal
   testing (up to 100 members of your team) needs **no App Review**. External
   groups require a lightweight beta review — not needed for personal use.
3. Install via the TestFlight app on your phone.

A manual Product → Archive → Distribute → Upload still works if you ever need
it, but the tag-driven lane is the intended path.

## 5. Updating

Ship a build by pushing an `ios-v*` tag (or dispatching the **Release**
workflow) — Xcode Cloud archives and uploads, and TestFlight picks it up
automatically for internal testers. Build numbers are stamped automatically from
`CI_BUILD_NUMBER`; only bump `MARKETING_VERSION` in `project.yml` when the
user-facing x.y.z changes. Details: [setup-xcode-cloud.md](setup-xcode-cloud.md).
