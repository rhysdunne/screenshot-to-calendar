import SwiftUI
import GoogleSignIn

/// App-wide state: session, settings, capture library, deep-link routing.
@MainActor
final class AppState: ObservableObject {
    @Published var isSignedIn = KeychainStore.token != nil
    /// False until the first `bootstrap()` (or a fresh `signIn`) has resolved
    /// `settings`. The router shows a launch splash while this is false so a
    /// returning user never flashes the calendar picker before settings load.
    @Published var didBootstrap = false
    @Published var settings: UserSettings?
    @Published var captures: [Capture] = []
    @Published var pendingDeepLinkCaptureId: String?
    @Published var lastError: String?

    let api = APIClient()
    lazy var images = CaptureImageStore(api: api)

    // MARK: Lifecycle

    func bootstrap() async {
        guard isSignedIn else { return }
        defer { didBootstrap = true }
        do {
            settings = try await api.getSettings()
            await refreshCaptures()
        } catch let APIError.unauthorized(code) {
            if code == "needs_reauth" || code == "unauthorized" { signOutLocally() }
        } catch {
            lastError = error.localizedDescription
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
                lastError = "Google did not return a server auth code — try again."
                return
            }
            let auth = try await api.signIn(serverAuthCode: code)
            KeychainStore.token = auth.token
            settings = auth.user.settings
            isSignedIn = true
            didBootstrap = true
            await refreshCaptures()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func signOutLocally() {
        KeychainStore.token = nil
        GIDSignIn.sharedInstance.signOut()
        isSignedIn = false
        didBootstrap = false
        settings = nil
        captures = []
        images.removeAll()
    }

    // MARK: Captures

    func refreshCaptures() async {
        do {
            captures = try await api.listCaptures().captures
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Poll while any capture is still processing (share-extension handoff).
    /// 2s interval, 60s cap — processing normally lands well under 20s.
    func pollWhileProcessing() async {
        for _ in 0..<30 {
            guard captures.contains(where: { !$0.status.isTerminal }) else { return }
            try? await Task.sleep(for: .seconds(2))
            await refreshCaptures()
        }
    }

    // MARK: Deep links (https://<cloudfront>/c/<captureId>)

    func handleDeepLink(_ url: URL) {
        let parts = url.pathComponents
        guard parts.count >= 3, parts[1] == "c" else { return }
        pendingDeepLinkCaptureId = parts[2]
    }
}
