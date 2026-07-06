import SwiftUI
import GoogleSignIn

@main
struct Screenshot2CalApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .onOpenURL { url in
                    // Google Sign-In callback or a universal link.
                    if GIDSignIn.sharedInstance.handle(url) { return }
                    appState.handleDeepLink(url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL {
                        appState.handleDeepLink(url)
                    }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            if !appState.isSignedIn {
                SignInView()
            } else if appState.settings?.calendarId == nil {
                OnboardingView()
            } else {
                LibraryView()
            }
        }
        .task { await appState.bootstrap() }
    }
}
