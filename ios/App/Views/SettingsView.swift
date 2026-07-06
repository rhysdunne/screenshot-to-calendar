import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var calendars: [CalendarEntry] = []
    @State private var showDeleteConfirm = false
    @State private var exportURL: URL?
    @State private var infoMessage: String?

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
                        if let response = try? await appState.api.exportAccount() {
                            exportURL = URL(string: response.url)
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
                Button("Sign out") { appState.signOutLocally() }
            }
        }
        .navigationTitle("Settings")
        .task {
            calendars = (try? await appState.api.listCalendars().calendars) ?? []
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
                    try? await appState.api.deleteAccount()
                    appState.signOutLocally()
                }
            }
        }
        .alert("Info", isPresented: .constant(infoMessage != nil)) {
            Button("OK") { infoMessage = nil }
        } message: { Text(infoMessage ?? "") }
    }

    private var calendarBinding: Binding<String?> {
        Binding(
            get: { appState.settings?.calendarId },
            set: { newValue in
                guard var settings = appState.settings else { return }
                settings.calendarId = newValue
                Task { appState.settings = try? await appState.api.updateSettings(settings) }
            }
        )
    }

    private var consentBinding: Binding<Bool> {
        Binding(
            get: { appState.settings?.consentEvalUse ?? false },
            set: { newValue in
                guard var settings = appState.settings else { return }
                settings.consentEvalUse = newValue
                Task { appState.settings = try? await appState.api.updateSettings(settings) }
            }
        )
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
            Text("The download link is valid for one hour.")
                .font(.callout).foregroundStyle(.secondary)
            Link("Download export", destination: url)
                .buttonStyle(.borderedProminent)
            Spacer()
        }
    }
}
