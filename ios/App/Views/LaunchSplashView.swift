import SwiftUI

/// Shown while a signed-in user's settings are still loading on launch. Mirrors
/// `SignInView`'s brand treatment (📸 + title) so the hand-off into the library
/// reads as one continuous screen rather than a swap. Without this the router
/// would fall through to the calendar picker until `getSettings()` returns.
struct LaunchSplashView: View {
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("📸").font(.system(size: 64))
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            ProgressView()
                .padding(.top, 8)
            Spacer()
        }
    }
}
