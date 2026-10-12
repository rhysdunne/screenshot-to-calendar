import SwiftUI

/// First-run: pick (or create) the calendar events go into.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState
    @State private var calendars: [CalendarEntry] = []
    @State private var newCalendarName = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    /// The router only shows this view once settings have loaded, so this is a
    /// backstop: never pick or create a calendar that can't then be saved.
    private static let settingsMissing = "Your settings haven't loaded, so this choice can't be saved. Close and reopen the app, then try again."

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Captured events need a home. Pick an existing Google calendar or create a dedicated one (recommended — easy to toggle on and off).")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Section("Your calendars") {
                    ForEach(calendars) { calendar in
                        Button {
                            Task { await select(calendar.id) }
                        } label: {
                            HStack {
                                Text(calendar.summary)
                                if calendar.primary == true {
                                    Text("primary").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section("Create new") {
                    HStack {
                        TextField("e.g. Captured Events", text: $newCalendarName)
                        Button("Create") {
                            Task { await createAndSelect() }
                        }
                        .disabled(newCalendarName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .navigationTitle("Choose a calendar")
            .overlay { if isWorking { ProgressView() } }
            .task { await loadCalendars() }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }

    private func loadCalendars() async {
        do {
            calendars = try await appState.api.listCalendars().calendars
        } catch {
            errorMessage = "Couldn't load your calendars. Check your connection and try again — you can still create a new one below."
        }
    }

    private func select(_ calendarId: String) async {
        guard var settings = appState.settings else {
            errorMessage = Self.settingsMissing
            return
        }
        isWorking = true
        defer { isWorking = false }
        settings.calendarId = calendarId
        // New accounts start on Europe/London. Take the device's zone at the
        // same time, so a user elsewhere gets the right "today" and event
        // times from the first capture. Settings can change it later.
        settings.timezone = TimeZone.current.identifier
        do {
            // Assign only on success — never overwrite good settings with nil,
            // which would bounce the user back to this picker.
            appState.settings = try await appState.api.updateSettings(settings)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createAndSelect() async {
        // Check first: select() can't save without settings, so creating the
        // Google calendar would leave it orphaned.
        guard appState.settings != nil else {
            errorMessage = Self.settingsMissing
            return
        }
        isWorking = true
        do {
            let created = try await appState.api.createCalendar(
                summary: newCalendarName.trimmingCharacters(in: .whitespaces))
            await select(created.id)
        } catch {
            errorMessage = error.localizedDescription
        }
        isWorking = false
    }
}
