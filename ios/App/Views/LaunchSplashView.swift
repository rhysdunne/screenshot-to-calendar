import SwiftUI

/// Shown while a signed-in user's settings load on launch: the app name and a
/// spinner. Without this the router would fall through to the calendar picker
/// until `getSettings()` returns.
struct LaunchSplashView: View {
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            ProgressView()
                .controlSize(.large)
            Spacer()
        }
    }
}

#Preview { LaunchSplashView() }
