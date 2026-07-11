import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var calendars: [CalendarEntry] = []
    @State private var showDeleteConfirm = false
    @State private var exportURL: URL?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("Target calendar") {
                Picker("Calendar", selection: calendarBinding) {
                    ForEach(calendars) { calendar in
                        Text(calendar.summary).tag(calendar.id as String?)
                    }
                }
            }

            Section {
                Toggle("Help improve extraction", isOn: consentBinding)
            } footer: {
                Text("Off by default. When on, corrections you make (and the images they belong to) may be used to improve the extraction prompt. See the privacy policy for details.")
            }

            Section("Your data") {
                Button {
                    Task {
                        do {
                            let response = try await appState.api.exportAccount()
                            exportURL = URL(string: response.url)
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                } label: {
                    Label("Export my data", systemImage: "square.and.arrow.up")
                }
                Button(role: .destructive) { showDeleteConfirm = true } label: {
                    Label("Delete account", systemImage: "trash")
                }
            }

            Section("About") {
                Link("Privacy policy",
                     destination: URL(string: "https://\(AppConfig.webDomain)/privacy.html")!)
                Link("Terms of service",
                     destination: URL(string: "https://\(AppConfig.webDomain)/terms.html")!)
                Link("Contact us",
                     destination: URL(string: "mailto:\(AppConfig.supportEmail)")!)
                Button("Sign out") { appState.signOutLocally() }
            }
        }
        .navigationTitle("Settings")
        .task {
            do {
                calendars = try await appState.api.listCalendars().calendars
            } catch {
                errorMessage = "Couldn't load your calendars. Check your connection and reopen Settings to try again."
            }
        }
        .sheet(item: $exportURL) { url in
            SafariLink(url: url)
        }
        .confirmationDialog(
            "Delete your account? All captures, images, and records are removed and Google Calendar access is revoked. Events already in your calendar stay.",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete everything", role: .destructive) {
                Task {
                    do {
                        try await appState.api.deleteAccount()
                        appState.signOutLocally()
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
        }
        .alert("Error", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }

    private var calendarBinding: Binding<String?> {
        Binding(
            get: { appState.settings?.calendarId },
            set: { newValue in
                guard var settings = appState.settings else { return }
                settings.calendarId = newValue
                Task { await save(settings) }
            }
        )
    }

    private var consentBinding: Binding<Bool> {
        Binding(
            get: { appState.settings?.consentEvalUse ?? false },
            set: { newValue in
                guard var settings = appState.settings else { return }
                settings.consentEvalUse = newValue
                Task { await save(settings) }
            }
        )
    }

    /// Persist a settings change. On failure, surface it and leave the existing
    /// `appState.settings` untouched — the control reverts to its prior value on
    /// the next render, and we never overwrite good settings with nil (which
    /// would bounce the user to the calendar picker).
    private func save(_ settings: UserSettings) async {
        do {
            appState.settings = try await appState.api.updateSettings(settings)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

private struct SafariLink: View {
    let url: URL
    var body: some View {
        VStack(spacing: 16) {
            Text("Your export is ready").font(.headline).padding(.top, 32)
            Text("The download link, and the image links inside it, are valid for one hour — download soon.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Link("Download export", destination: url)
                .buttonStyle(.borderedProminent)
            Spacer()
        }
    }
}
