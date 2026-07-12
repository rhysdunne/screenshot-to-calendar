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
            } else if !appState.didBootstrap {
                // Signed in, but settings haven't loaded yet. Show a splash
                // rather than falling through to OnboardingView — otherwise a
                // returning user sees the calendar picker flash until the
                // async getSettings() lands.
                LaunchSplashView()
            } else if appState.settings?.calendarId == nil {
                OnboardingView()
            } else {
                LibraryView()
            }
        }
        .tint(.brandTint)
        .task { await appState.bootstrap() }
    }
}
