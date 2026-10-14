import SwiftUI
import GoogleSignIn

/// App-wide state: session, settings, capture library, deep-link routing.
@MainActor
final class AppState: ObservableObject {
    @Published var isSignedIn = KeychainStore.token != nil
    /// False until `bootstrap()` has loaded `settings` and made the first captures
    /// fetch (a fresh `signIn` sets it itself). The router shows a launch splash
    /// while this is false, so a returning user never flashes the calendar picker
    /// before settings load, or the empty library before their captures arrive. A
    /// failed settings load leaves it false (and sets `bootstrapError`), so the
    /// splash offers a retry rather than routing on with no settings. A failed
    /// captures fetch still routes on (`refreshCaptures()` only sets
    /// `capturesError`, which the library shows with a retry).
    @Published var didBootstrap = false
    /// Why the last `bootstrap()` couldn't load settings (offline, 5xx, timeout).
    /// Non-nil turns the launch splash into a "Try again" screen.
    @Published var bootstrapError: String?
    @Published var settings: UserSettings?
    @Published var captures: [Capture] = []
    /// The last good captures fetch came back with a cursor: `captures` is one
    /// page of the newest shares (up to 200, or fewer if DynamoDB's 1 MB read
    /// limit cut it short), and older captures may be missing. The app does
    /// not follow the cursor. At exactly 200 it is true although nothing is
    /// missing, because DynamoDB returns a cursor whenever it stops at the
    /// limit. A new share keeps it true (one capture then really is missing);
    /// only a delete back below 200 clears it. It changes only where
    /// `captures` does, so it always describes the list on screen.
    @Published var hasMoreCaptures = false
    @Published var pendingDeepLinkCaptureId: String?
    /// Why the last `signIn` failed. Set only there, and never for a user
    /// cancel. SignInView shows it, and so does the library when a reconnect
    /// attempt fails. The capture detail view takes it over when its own
    /// Reconnect fails, because the library's alert can't show over the sheet.
    @Published var signInError: String?
    /// Why the last captures fetch failed (offline, 5xx, timeout). The library
    /// shows it as a retry screen when empty, or a small row above the list.
    @Published var capturesError: String?
    /// The backend can no longer use the user's Google grant (revoked, or the
    /// refresh token expired). Signing out would lose unsaved edits, so the
    /// library banner and the capture detail's error alert offer "Reconnect"
    /// instead, which re-runs `signIn`.
    @Published var needsReauth = false

    let api = APIClient()
    lazy var images = CaptureImageStore(api: api)
    /// The one foreground refresh-and-poll in flight. Replaced, never stacked,
    /// so quick background/foreground flips can't run parallel 2s loops.
    private var foregroundRefresh: Task<Void, Never>?

    // MARK: Lifecycle

    /// Loads settings, then captures, for a returning user. `didBootstrap` flips
    /// only after both, so the splash covers the whole launch. A no-op once that
    /// has happened (`signIn` loads both itself), so re-running on a route change
    /// or a retry tap is safe.
    func bootstrap() async {
        guard isSignedIn, !didBootstrap else { return }
        if signOutIfSessionExpiring() { return }
        bootstrapError = nil
        do {
            settings = try await api.getSettings()
            await refreshCaptures()
            didBootstrap = true
        } catch let APIError.unauthorized(code) where code == "needs_reauth" || code == "unauthorized" {
            signOutLocally()
        } catch {
            bootstrapError = error.localizedDescription
        }
    }

    // MARK: Google Sign-In

    /// Full calendar scope is needed so the backend can list, create, and
    /// create-into calendars the user picks.
    private static let calendarScope = "https://www.googleapis.com/auth/calendar"

    func signIn(presenting viewController: UIViewController) async {
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(
                withPresenting: viewController,
                hint: nil,
                additionalScopes: [Self.calendarScope]
            )
            guard let code = result.serverAuthCode else {
                signInError = "Google did not return a server auth code — try again."
                return
            }
            let auth = try await api.signIn(serverAuthCode: code)
            // Throws before isSignedIn flips, so a failed save shows as a
            // sign-in error instead of a session with no token.
            try KeychainStore.save(auth.token)
            settings = auth.user.settings
            isSignedIn = true
            didBootstrap = true
            // Also the reconnect path: a fresh sign-in stores a new Google grant.
            needsReauth = false
            await refreshCaptures()
        } catch GIDSignInError.canceled {
            // Closing Google's sheet or declining its consent screen is the
            // user's choice, not a failure, so no alert. On the reconnect
            // path `needsReauth` stays set, so Reconnect is still offered.
        } catch {
            signInError = error.localizedDescription
        }
    }

    func signOutLocally() {
        foregroundRefresh?.cancel()
        foregroundRefresh = nil
        KeychainStore.clear()
        UploadBodyStore.removeAll()
        GIDSignIn.sharedInstance.signOut()
        isSignedIn = false
        didBootstrap = false
        settings = nil
        captures = []
        hasMoreCaptures = false
        signInError = nil
        capturesError = nil
        needsReauth = false
        images.removeAll()
    }

    /// Signs out if the stored session has expired or expires within the
    /// hour. The share extension refuses shares in that window, so the app
    /// shows sign-in too rather than look signed in. True if it signed out.
    private func signOutIfSessionExpiring() -> Bool {
        guard let token = KeychainStore.token, SessionToken.expiresSoon(token) else { return false }
        signOutLocally()
        return true
    }

    // MARK: Captures

    /// Fetches the library. Background refreshes (the 2s poll) pass
    /// `reportErrors: false`, so a failed tick stays quiet instead of flashing
    /// an error row. Any success clears an error shown earlier.
    func refreshCaptures(reportErrors: Bool = true) async {
        do {
            let page = try await api.listCaptures()
            captures = page.captures
            hasMoreCaptures = page.cursor != nil
            capturesError = nil
        } catch let APIError.unauthorized(code) where code == "unauthorized" {
            // The session itself is gone (revoked, or the user no longer exists).
            signOutLocally()
        } catch let APIError.unauthorized(code) where code == "needs_reauth" {
            needsReauth = true
        } catch {
            // A cancelled fetch (pull-to-refresh abandoned, or a newer refresh
            // took over) is not a failure worth showing.
            if reportErrors, !Task.isCancelled { capturesError = error.localizedDescription }
        }
    }

    /// Called when the library comes to the foreground. The share extension
    /// can't wake the app, so look for new captures, then poll any still
    /// processing. `fetchFirst` is false when the library first appears,
    /// because bootstrap or sign-in has only just fetched.
    func refreshOnForeground(fetchFirst: Bool) {
        if signOutIfSessionExpiring() { return }
        foregroundRefresh?.cancel()
        foregroundRefresh = Task {
            if fetchFirst { await refreshCaptures() }
            // A share still uploading when the app came forward isn't listed
            // yet. One more look a few seconds later picks it up.
            if !hasCapturesInProgress {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await refreshCaptures(reportErrors: false)
            }
            await pollWhileProcessing()
        }
    }

    private var hasCapturesInProgress: Bool {
        captures.contains { !$0.status.isTerminal }
    }

    /// Poll while any capture is still processing (share-extension handoff).
    /// 2s interval, 60s cap — processing normally lands well under 20s.
    /// Stops at once if the surrounding task is cancelled.
    private func pollWhileProcessing() async {
        for _ in 0..<30 {
            guard hasCapturesInProgress else { return }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            await refreshCaptures(reportErrors: false)
        }
    }

    /// The message for a failed capture action (save, approve, delete). These
    /// reach Google and the library fetch does not, so a revoked grant usually
    /// shows up here first: flag it, so the detail view's alert offers
    /// Reconnect in place (Close would discard unsaved edits) and the
    /// library's banner is waiting when the sheet closes.
    func message(for error: Error) -> String {
        if case let APIError.unauthorized(code) = error, code == "needs_reauth" {
            needsReauth = true
            return "Google needs you to reconnect your account. Tap Reconnect, then try again. Your edits here are kept."
        }
        return error.localizedDescription
    }

    // MARK: Deep links (https://<cloudfront>/c/<captureId>)

    func handleDeepLink(_ url: URL) {
        let parts = url.pathComponents
        guard parts.count >= 3, parts[1] == "c" else { return }
        pendingDeepLinkCaptureId = parts[2]
    }
}
