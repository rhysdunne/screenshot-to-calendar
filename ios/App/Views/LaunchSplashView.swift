import SwiftUI

/// Shown while a signed-in user's settings and captures load on launch: the app
/// name and a spinner, or the error and a retry button if settings failed to load.
/// Without this the router would fall through to the calendar picker until
/// `getSettings()` returns.
struct LaunchSplashView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            if let error = appState.bootstrapError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Try again") {
                    Task { await appState.bootstrap() }
                }
                .buttonStyle(.borderedProminent)
            } else {
                ProgressView()
                    .controlSize(.large)
            }
            Spacer()
        }
    }
}

#Preview("Loading") {
    LaunchSplashView()
        .environmentObject(AppState())
}

#Preview("Failed") {
    let appState = AppState()
    appState.bootstrapError = "The Internet connection appears to be offline."
    return LaunchSplashView()
        .environmentObject(appState)
}
