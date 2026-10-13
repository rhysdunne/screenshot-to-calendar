import SwiftUI

/// The Events list: captures as text rows, sorted by event date into
/// sections (EventSections.swift). The poster stays one tap away in the
/// detail sheet, and a long press previews it.
struct LibraryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedCapture: Capture?
    @State private var isRetrying = false
    @State private var isReconnecting = false
    /// Set when the app goes to the background, so only a real return (from
    /// sharing, say) fetches first. The launch's own inactive-to-active step
    /// and a glance at Control Centre don't.
    @State private var wasInBackground = false
    /// Past grows without limit, so it starts collapsed and "Other captures"
    /// below it stays in reach.
    @State private var isPastExpanded = false

    var body: some View {
        NavigationStack {
            Group {
                if appState.captures.isEmpty {
                    // A ScrollView, not the List: the centred empty and error
                    // states size themselves to it, and pull-to-refresh works
                    // with zero captures.
                    ScrollView {
                        VStack(spacing: 0) {
                            if appState.needsReauth {
                                reconnectBanner.padding([.horizontal, .top])
                            }
                            if let error = appState.capturesError {
                                loadErrorState(error)
                            } else {
                                emptyState
                            }
                        }
                    }
                } else {
                    eventList
                }
            }
            .navigationTitle("Events")
            .toolbar {
                NavigationLink {
                    SettingsView()
                } label: {
                    Image(systemName: "gearshape")
                }
            }
            .refreshable { await appState.refreshCaptures() }
            .sheet(item: $selectedCapture) { capture in
                CaptureDetailView(captureId: capture.captureId)
            }
            .onChange(of: scenePhase, initial: true) { _, phase in
                // The share extension can't wake the app; refresh + poll when
                // the user comes back after sharing. The first appearance
                // comes just after bootstrap or sign-in fetched, so it only
                // polls.
                switch phase {
                case .background:
                    wasInBackground = true
                case .active:
                    appState.refreshOnForeground(fetchFirst: wasInBackground)
                    wasInBackground = false
                default:
                    break
                }
            }
            // initial: a link that cold-launches the app is set before the
            // list appears (behind the launch splash), so there is no change
            // to observe. Without it the link was dropped.
            .onChange(of: appState.pendingDeepLinkCaptureId, initial: true) { _, captureId in
                guard let captureId else { return }
                appState.pendingDeepLinkCaptureId = nil
                selectedCapture = appState.captures.first { $0.captureId == captureId }
                    ?? Capture(captureId: captureId, status: .completed, createdAt: "")
            }
            // A failed reconnect; SignInView shows the same error before sign-in.
            .alert("Couldn't reconnect", isPresented: .constant(appState.signInError != nil)) {
                Button("OK") { appState.signInError = nil }
            } message: {
                Text(appState.signInError ?? "")
            }
        }
    }

    // MARK: Sections

    private var eventList: some View {
        // Once a minute, so "today" moves on at midnight even while the list
        // sits on screen untouched. Re-sorting a few hundred captures is cheap.
        TimelineView(.everyMinute) { context in
            eventSections(now: context.date)
        }
    }

    private func eventSections(now: Date) -> some View {
        let zone = EventDates.zone(identifier: appState.settings?.timezone)
        let today = EventDates.today(in: zone, now: now)
        let sections = EventSections(appState.captures, today: today)

        return List {
            // Separate sections: in one, the clear-backed banner ran into the
            // error row below it.
            if appState.needsReauth {
                Section {
                    reconnectBanner
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            if let error = appState.capturesError {
                Section { refreshErrorRow(error) }
            }

            if !sections.processing.isEmpty {
                Section("Processing") {
                    rows(sections.processing, today: today, zone: zone)
                }
            }

            if !sections.review.isEmpty {
                Section("Needs your review (\(sections.review.count))") {
                    // Prefetch these posters: the next step is to open one
                    // and compare it with the fields.
                    rows(sections.review, today: today, zone: zone, prefetchImages: true)
                }
            }

            Section("Upcoming") {
                if sections.upcoming.isEmpty {
                    Text("Nothing coming up. Share a screenshot of an event poster to add one.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    rows(sections.upcoming, today: today, zone: zone)
                }
            }

            if !sections.onNow.isEmpty {
                Section("On now") {
                    rows(sections.onNow, today: today, zone: zone, whenStyle: .until)
                }
            }

            if !sections.past.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $isPastExpanded) {
                        rows(sections.past, today: today, zone: zone, isPast: true)
                    } label: {
                        Text("Past (\(sections.past.count))")
                    }
                }
            }

            if !sections.other.isEmpty {
                Section {
                    rows(sections.other, today: today, zone: zone)
                } header: {
                    Text("Other captures")
                } footer: {
                    Text("Screenshots that didn't become a dated event.")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// One tappable row per capture. A tap opens the detail sheet. A long
    /// press previews the poster, so it can be checked without opening.
    @ViewBuilder private func rows(_ captures: [Capture], today: String, zone: TimeZone,
                                   whenStyle: EventWhen.Style = .full, isPast: Bool = false,
                                   prefetchImages: Bool = false) -> some View {
        ForEach(captures) { capture in
            Button { selectedCapture = capture } label: {
                EventRow(capture: capture, today: today, zone: zone,
                         whenStyle: whenStyle, isPast: isPast)
            }
            .contextMenu {
                Button { selectedCapture = capture } label: {
                    Label("Show details", systemImage: "info.circle")
                }
            } preview: {
                PosterPreview(captureId: capture.captureId, images: appState.images)
            }
            .task(id: capture.captureId) {
                guard prefetchImages else { return }
                _ = await appState.images.image(for: capture.captureId)
            }
        }
    }

    // MARK: Empty and failure states

    /// Sized to the scroll view's visible height so it sits centred, but still
    /// inside the ScrollView so pull-to-refresh works with zero captures.
    private var emptyState: some View {
        ContentUnavailableView {
            Label("No events yet", systemImage: "calendar")
        } description: {
            Text("Screenshot an event poster or post, then share the screenshot and pick “Capture Event”.")
        }
        .containerRelativeFrame(.vertical)
    }

    /// The first fetch failed and there is nothing cached to show. Sized like
    /// `emptyState` so pull-to-refresh still works too.
    private func loadErrorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't load your events", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { Task { await retry() } }
                .buttonStyle(.borderedProminent)
                .disabled(isRetrying)
        }
        .containerRelativeFrame(.vertical)
    }

    /// A refresh failed but the last good list is still on screen, so keep it
    /// and say so in one quiet line.
    private func refreshErrorRow(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
            Text("Couldn't refresh. \(message)")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("Retry") { Task { await retry() } }
                .font(.footnote.weight(.semibold))
                // Borderless, so only the button retries, not a tap anywhere
                // on the List row.
                .buttonStyle(.borderless)
                .disabled(isRetrying)
        }
    }

    /// The backend lost the Google grant. Captures and unsaved edits stay; a
    /// fresh Google sign-in stores a new grant and clears the banner.
    private var reconnectBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("Reconnect your Google account")
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            .font(.subheadline.weight(.semibold))
            Text("Google stopped accepting this app's access, so captures can't reach your calendar until you sign in with Google again.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Reconnect") { Task { await reconnect() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isReconnecting)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }

    private func retry() async {
        isRetrying = true
        await appState.refreshCaptures()
        isRetrying = false
    }

    private func reconnect() async {
        guard let root = UIApplication.shared.rootViewController else { return }
        isReconnecting = true
        await appState.signIn(presenting: root)
        isReconnecting = false
    }
}

/// One capture as text: what, when, where. Pure, with no AppState, so the
/// preview below can show every case with "today" pinned.
struct EventRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let capture: Capture
    let today: String
    let zone: TimeZone
    var whenStyle: EventWhen.Style = .full
    var isPast = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let event = capture.effectiveEvent {
                eventLines(event)
            } else {
                statusLines
            }
        }
        // Colours, not the hierarchical .primary/.secondary styles: inside a
        // List button those resolve against the tint, so the text came out
        // blue-grey. Past rows grey out with semantic colours, which adapt to
        // dark mode and Increase Contrast, and the "Past" label says it too.
        .foregroundStyle(isPast ? Color.secondary : Color.primary)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func eventLines(_ event: ExtractedEvent) -> some View {
        Text(title(event))
            .font(.body.weight(.semibold))
            .lineLimit(2)
        if let when = EventWhen.text(for: event, today: today, style: whenStyle) {
            Text(when).font(.subheadline)
        } else {
            Text("No date").font(.subheadline).foregroundStyle(.orange)
        }
        if let place = whereAndWhat(event) {
            Text(place)
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
        }
        // Its own line, so at large text sizes it never squeezes the title.
        // "In calendar" is the normal case and gets no badge.
        if capture.status != .completed {
            StatusBadge(status: capture.status).padding(.top, 2)
        }
    }

    /// Rows with no event yet (processing) or none at all (not an event,
    /// failed): the status is the title.
    @ViewBuilder private var statusLines: some View {
        HStack {
            Text(capture.status.label).font(.body.weight(.semibold))
            if !capture.status.isTerminal {
                Spacer()
                ProgressView()
            }
        }
        if let shared = SharedAt.text(createdAt: capture.createdAt, zone: zone) {
            Text(shared).font(.subheadline).foregroundStyle(Color.secondary)
        }
    }

    /// The backend's calendar title falls back to "Untitled Event" too.
    private func title(_ event: ExtractedEvent) -> String {
        guard let title = event.title, !title.isEmpty else { return "Untitled event" }
        return title
    }

    /// "Jazz Cafe · Music". The venue, else the address, then the category.
    private func whereAndWhat(_ event: ExtractedEvent) -> String? {
        let place = [event.venue, event.address].compactMap { $0 }.first { !$0.isEmpty }
        let parts = [place, EventCategoryLabel.text(event.category)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The long-press preview: the poster at a fixed size, so the menu does not
/// resize when the image arrives.
private struct PosterPreview: View {
    let captureId: String
    let images: CaptureImageStore
    @State private var image: UIImage?
    @State private var didFail = false

    var body: some View {
        ZStack {
            Color(.secondarySystemBackground)
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else if didFail {
                Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(width: 280, height: 373)
        .task {
            image = await images.image(for: captureId)
            didFail = image == nil
        }
    }
}

struct StatusBadge: View {
    let status: CaptureStatus

    var body: some View {
        // No line limit: at the largest text sizes "Already in calendar" is
        // wider than a row, and wrapping beats "Already in cal…".
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .completed: return .green
        case .queued, .processing, .needsReview: return .orange
        case .failed: return .red
        case .duplicate: return .blue
        case .notEvent: return .secondary
        }
    }
}

#Preview("Event rows") {
    // "Today" is pinned, so the sections and dates in this preview never move.
    let today = "2026-10-13"
    let zone = EventDates.zone(identifier: "Europe/London")
    func capture(_ id: String, _ status: CaptureStatus = .completed, title: String? = nil,
                 venue: String? = nil, category: String? = nil, start: String? = nil,
                 end: String? = nil, startTime: String? = nil, endTime: String? = nil) -> Capture {
        let event = title.map {
            ExtractedEvent(title: $0, venue: venue, startDate: start, endDate: end,
                           startTime: startTime, endTime: endTime, category: category)
        }
        return Capture(captureId: id, status: status, createdAt: "2026-10-12T14:22:01.456Z", event: event)
    }
    let captures = [
        capture("01", .processing),
        capture("02", .needsReview, title: "Supper Club", venue: "Peckham Levels",
                category: "food_drink", start: "2027-10-03", startTime: "19:00"),
        capture("03", .failed, title: "Open Studios", venue: "Cockpit Arts"),
        capture("04", title: "Film Club", venue: "Rio Cinema", category: "film",
                start: "2026-10-13", startTime: "20:00"),
        capture("05", title: "Ezra Collective", venue: "Jazz Cafe", category: "music",
                start: "2026-10-18", startTime: "19:30", endTime: "23:00"),
        capture("06", .duplicate, title: "Ezra Collective", venue: "Jazz Cafe", category: "music",
                start: "2026-10-18", startTime: "19:30"),
        capture("07", title: "Frieze London", venue: "Regent's Park", category: "exhibition",
                start: "2026-10-14", end: "2026-10-18"),
        capture("08", title: "Hockney: Drawing from Life", venue: "National Portrait Gallery",
                category: "exhibition", start: "2026-09-01", end: "2026-11-30"),
        capture("09", title: "Late at the Tate", end: "2026-10-31"),
        capture("10", title: "Quiz Night", venue: "The Albert", start: "2026-10-10", startTime: "19:00"),
        capture("11", .notEvent),
    ]
    let sections = EventSections(captures, today: today)
    return List {
        Section("Processing") {
            ForEach(sections.processing) { EventRow(capture: $0, today: today, zone: zone) }
        }
        Section("Needs your review (\(sections.review.count))") {
            ForEach(sections.review) { EventRow(capture: $0, today: today, zone: zone) }
        }
        Section("Upcoming") {
            ForEach(sections.upcoming) { EventRow(capture: $0, today: today, zone: zone) }
        }
        Section("On now") {
            ForEach(sections.onNow) { EventRow(capture: $0, today: today, zone: zone, whenStyle: .until) }
        }
        Section("Past") {
            ForEach(sections.past) { EventRow(capture: $0, today: today, zone: zone, isPast: true) }
        }
        Section("Other captures") {
            ForEach(sections.other) { EventRow(capture: $0, today: today, zone: zone) }
        }
    }
}
