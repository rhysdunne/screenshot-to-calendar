import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            PipelineMark(width: 200)
            Text("Screenshot to Calendar")
                .font(.title2.weight(.semibold))
            Text("Share a poster or Instagram post from anywhere — the event lands in your Google Calendar, checked for duplicates, with the original image a tap away.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
            Button {
                Task {
                    guard let root = UIApplication.shared.rootViewController else { return }
                    await appState.signIn(presenting: root)
                }
            } label: {
                Label("Sign in with Google", systemImage: "person.badge.key")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 32)

            VStack(spacing: 6) {
                Text("Calendar access is used only to create and update events you capture. Images you share are sent to Anthropic's Claude to extract event details.")
                Text("By continuing, you agree to our [Terms of Service](https://\(AppConfig.webDomain)/terms.html) and [Privacy Policy](https://\(AppConfig.webDomain)/privacy.html).")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .padding(.bottom, 24)
        }
        .alert("Sign-in failed", isPresented: .constant(appState.lastError != nil)) {
            Button("OK") { appState.lastError = nil }
        } message: {
            Text(appState.lastError ?? "")
        }
    }
}

extension UIApplication {
    var rootViewController: UIViewController? {
        connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.rootViewController
    }
}
