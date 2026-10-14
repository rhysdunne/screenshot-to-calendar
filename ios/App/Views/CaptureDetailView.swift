import SwiftUI

/// Source image + editable event fields. Saving PATCHes only changed fields;
/// the backend records each change as a correction and updates the calendar.
struct CaptureDetailView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let captureId: String

    @State private var capture: Capture?
    /// Decoded via the app-wide CaptureImageStore, so a list row that already
    /// loaded this capture (a review row's prefetch, or a long-press preview)
    /// makes the detail image instant (and vice versa).
    @State private var imageState: ImageState = .loading
    /// Drives the full-screen viewer. Item-based (not a bool) so the image is
    /// passed into the cover atomically at tap time — presenting via
    /// `isPresented` + reading the image state inside the cover raced: on a
    /// slow (uncached) first load the cover could build before the image was
    /// visible to its closure, presenting an empty (black) cover. See #67.
    @State private var viewerImage: ViewerImage?
    @State private var form = ExtractedEvent()
    /// Today's date, when it was put in `form` only because the extraction had
    /// no start date. Opening a capture is not an edit, so `hasChanges` and
    /// Save ignore it. Approve sends it, because approving accepts what's on
    /// screen and a calendar event needs a date.
    @State private var seededStartDate: String?
    @State private var isSaving = false
    @State private var showDeleteConfirm = false
    @State private var showDiscardConfirm = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                imageSection
                if let capture {
                    statusSection(capture)
                    if capture.event != nil {
                        fieldsSection
                        if canApprove(capture) || capture.eventLink != nil {
                            actionsSection(capture)
                        }
                    }
                    // Always available — including not_event and other event-less
                    // captures, which previously had no way to be removed.
                    deleteSection
                }
            }
            .navigationTitle("Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(isSaving || !hasChanges)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        if hasChanges { showDiscardConfirm = true } else { dismiss() }
                    }
                }
            }
            // A swipe down would drop unsaved edits without asking, so block it
            // while there are any. Close asks first (SwiftUI has no hook to ask
            // on the swipe itself).
            .interactiveDismissDisabled(hasChanges)
            .confirmationDialog("Discard changes?", isPresented: $showDiscardConfirm,
                                titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .task { await load() }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                if appState.needsReauth {
                    // Reconnecting here keeps the form, so Save or Approve
                    // can be tapped again. Close would discard the edits.
                    Button("Reconnect") {
                        errorMessage = nil
                        Task { await reconnect() }
                    }
                    Button("Not now", role: .cancel) { errorMessage = nil }
                } else {
                    Button("OK") { errorMessage = nil }
                }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Delete this capture?", isPresented: $showDeleteConfirm,
                                titleVisibility: isDuplicate ? .visible : .automatic) {
                if isDuplicate {
                    // A duplicate's calendar event is the one it matched, which
                    // belongs to another capture or was already in the calendar.
                    Button("Delete capture", role: .destructive) {
                        Task { await delete(deleteEvent: false) }
                    }
                } else {
                    Button("Delete capture and calendar event", role: .destructive) {
                        Task { await delete(deleteEvent: true) }
                    }
                    Button("Delete capture only", role: .destructive) {
                        Task { await delete(deleteEvent: false) }
                    }
                }
            } message: {
                if isDuplicate {
                    Text("The matching event stays in your calendar.")
                }
            }
            // Presented from Form level, like the alert/dialog above — a
            // fullScreenCover attached inside a Form row can present an empty
            // (black) cover because the row's host may be detached when the
            // presentation fires.
            .fullScreenCover(item: $viewerImage) { viewer in
                ImageViewerView(image: viewer.image)
            }
        }
    }

    /// Loading, failed or loaded, each visibly different. Only a loaded image
    /// is tappable (and announced as a button), so a tap never silently
    /// does nothing while the image is still on its way (#68).
    private var imageSection: some View {
        Section {
            Group {
                switch imageState {
                case .loading:
                    // A fixed height is enough here: the spinner fits in
                    // 200 pt at every text size.
                    Rectangle().fill(.quaternary).frame(height: 200)
                        .overlay { ProgressView() }
                        .accessibilityElement()
                        .accessibilityLabel("Loading image")
                case .failed:
                    // A minimum height, not a fixed one: at the largest text
                    // sizes the icon, text and button need more than 200 pt,
                    // and a fixed frame cut them off (#132). When they fit,
                    // it stays at 200 pt, the loading height and image cap.
                    VStack(spacing: 8) {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("Image unavailable")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        // Failures are never cached, so a retry refetches.
                        Button("Try again") { Task { await loadImage() } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .background(.quaternary)
                case let .loaded(image):
                    Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                        // Capped at the placeholders' height: at full width a
                        // portrait screenshot filled the sheet and hid every
                        // field (#121). At 200 pt the image, the status and
                        // the fields down to Start date fit on a 6.1-inch
                        // iPhone at the default text size and one step larger,
                        // when Title, Venue and Address each fit on one line.
                        // One step larger, a longer value moves its label onto
                        // a line of its own and Start date no longer fits.
                        // maxWidth centres a narrow image. It goes before
                        // contentShape, so the whole row opens the viewer.
                        .frame(maxWidth: .infinity, maxHeight: 200)
                        .contentShape(Rectangle())
                        .onTapGesture { viewerImage = ViewerImage(image: Image(uiImage: image)) }
                        .accessibilityLabel("Capture image")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Opens the image full screen")
                }
            }
            .listRowInsets(EdgeInsets())
        }
    }

    private func statusSection(_ capture: Capture) -> some View {
        Section {
            HStack {
                StatusBadge(status: capture.status)
                Spacer()
                if let confidence = capture.event?.confidence {
                    ConfidenceMeter(confidence: confidence)
                }
            }
            if capture.status == .needsReview {
                Text("The AI wasn't confident about these details — check them (especially the dates), fix anything wrong, then add to calendar below.")
                    .font(.callout)
            }
            if capture.status == .notEvent {
                Text("This didn't look like an event, so nothing was added to your calendar. You can delete it below.")
                    .font(.callout)
            }
            if let error = capture.error {
                // Primary text, with the colour on the icon only: red text
                // was 3.6:1 on white (#124).
                Label {
                    Text(error)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                }
                .font(.callout)
            }
            if capture.possibleDuplicateOf != nil {
                Label("Might duplicate an existing event — check your calendar.",
                      systemImage: "exclamationmark.triangle")
                    .font(.callout)
            }
        }
    }

    private var fieldsSection: some View {
        Section {
            LabeledContent("Title") { TextField("Title", text: binding(\.title)) }
            LabeledContent("Venue") { TextField("Venue", text: binding(\.venue)) }
            LabeledContent("Address") { TextField("Address", text: binding(\.address)) }
            DatePicker("Start date", selection: startDateBinding, displayedComponents: .date)

            Toggle("Add a start time", isOn: startTimeOn)
            if form.startTime != nil {
                DatePicker("Start time", selection: startTimeBinding, displayedComponents: .hourAndMinute)
            }

            Toggle("Add an end date", isOn: endDateOn)
            if form.endDate != nil {
                DatePicker("End date", selection: endDateBinding,
                           in: startDateValue..., displayedComponents: .date)
            }

            Toggle("Add an end time", isOn: endTimeOn)
            if form.endTime != nil {
                DatePicker("End time", selection: endTimeBinding, displayedComponents: .hourAndMinute)
            }
            LabeledContent("URL") { TextField("URL", text: binding(\.url)) }
            // v3 read-only fields (corrections for these are a follow-up):
            if let price = capture?.effectiveEvent?.price {
                LabeledContent("Price") { Text(price) }
            }
            if let category = capture?.effectiveEvent?.category {
                LabeledContent("Category") {
                    Text(category.replacingOccurrences(of: "_", with: " ").capitalized)
                }
            }
        } header: {
            Text("Event details")
        } footer: {
            // Editable rows look just like read-only ones — say so once.
            VStack(alignment: .leading, spacing: 4) {
                Text("Tap a field to correct anything the AI got wrong.")
                if isDuplicate {
                    Text("This matched an event already in your calendar. Edits here don't change that event.")
                }
            }
        }
    }

    private var isDuplicate: Bool { capture?.status == .duplicate }

    // MARK: Date & time field mapping

    /// Wall-clock wire formats (`yyyy-MM-dd`, `HH:mm`). These carry no timezone —
    /// the backend attaches one from user settings — so parse and format both use
    /// the device timezone consistently, keeping DatePicker round-trips stable.
    private enum WireFormat {
        static let date: DateFormatter = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            return f
        }()
        static let time: DateFormatter = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "HH:mm"
            return f
        }()
    }

    private var startDateValue: Date { WireFormat.date.date(from: form.startDate ?? "") ?? Date() }

    /// Today in the user's settings zone, the zone the backend reads dates in.
    /// WireFormat uses the device zone, so it must not make "today": abroad,
    /// the device date can differ from the settings date, and the Events list
    /// and the backend both use the settings date.
    private var today: String {
        EventDates.today(in: EventDates.zone(identifier: appState.settings?.timezone))
    }

    private var startDateBinding: Binding<Date> {
        Binding(get: { startDateValue },
                set: { form.startDate = WireFormat.date.string(from: $0) })
    }

    private var startTimeOn: Binding<Bool> {
        Binding(get: { form.startTime != nil },
                set: { form.startTime = $0 ? (form.startTime ?? "09:00") : nil })
    }
    private var startTimeBinding: Binding<Date> {
        Binding(get: { WireFormat.time.date(from: form.startTime ?? "09:00") ?? Date() },
                set: { form.startTime = WireFormat.time.string(from: $0) })
    }

    private var endDateOn: Binding<Bool> {
        Binding(get: { form.endDate != nil },
                set: { form.endDate = $0 ? (form.endDate ?? form.startDate ?? today) : nil })
    }
    private var endDateBinding: Binding<Date> {
        Binding(get: { WireFormat.date.date(from: form.endDate ?? "") ?? startDateValue },
                set: { form.endDate = WireFormat.date.string(from: $0) })
    }

    private var endTimeOn: Binding<Bool> {
        Binding(get: { form.endTime != nil },
                set: { form.endTime = $0 ? (form.endTime ?? form.startTime ?? "10:00") : nil })
    }
    private var endTimeBinding: Binding<Date> {
        Binding(get: { WireFormat.time.date(from: form.endTime ?? "10:00") ?? Date() },
                set: { form.endTime = WireFormat.time.string(from: $0) })
    }

    /// A `needs_review` or a `failed`-with-event capture can still be added to
    /// the calendar by the user once they've checked the details.
    private func canApprove(_ capture: Capture) -> Bool {
        capture.status == .needsReview || (capture.status == .failed && capture.event != nil)
    }

    private func actionsSection(_ capture: Capture) -> some View {
        Section {
            if canApprove(capture) {
                Button {
                    Task { await approve() }
                } label: {
                    Label(isSaving ? "Adding…" : "Looks right — add to calendar",
                          systemImage: "checkmark.circle.fill")
                        // The List row's automatic label style drops the icon
                        // inside a prominent button — force it back.
                        .labelStyle(.titleAndIcon)
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                // A filled button, not a Form row — clear the row chrome so the
                // primary action of the review flow reads as one.
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .disabled(isSaving)
            }
            if let link = capture.eventLink, let url = URL(string: link) {
                Link(destination: url) { Label("Open in Google Calendar", systemImage: "calendar") }
            }
        }
    }

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) { showDeleteConfirm = true } label: {
                Label("Delete capture", systemImage: "trash")
            }
        }
    }

    /// One tap: saves any pending edits (and a seeded start date) first, so
    /// the event is created from what's on screen, then approves.
    private func approve() async {
        guard let original = capture?.effectiveEvent else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let edits = changedFields(from: original, includingSeededDate: true)
            if !edits.isEmpty {
                apply(try await appState.api.updateCapture(id: captureId, fields: edits))
            }
            apply(try await appState.api.approveCapture(id: captureId))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await appState.refreshCaptures()
        } catch {
            errorMessage = appState.message(for: error)
        }
    }

    // MARK: Data

    private func load() async {
        // Image and capture load in parallel — the image is often already
        // cached (review rows prefetch theirs), so it paints immediately
        // instead of waiting out the getCapture round-trip.
        Task { await loadImage() }
        do {
            apply(try await appState.api.getCapture(id: captureId))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Resets the form to a capture fresh from the server.
    private func apply(_ loaded: Capture) {
        capture = loaded
        form = loaded.effectiveEvent ?? ExtractedEvent()
        seededStartDate = nil
        // A calendar event needs a date; if the extraction had none, seed
        // today so the always-visible Start date picker has a value to edit.
        if loaded.event != nil, form.startDate == nil {
            let seed = today
            form.startDate = seed
            seededStartDate = seed
        }
    }

    private func loadImage() async {
        imageState = .loading
        if let image = await appState.images.image(for: captureId) {
            imageState = .loaded(image)
        } else {
            imageState = .failed
        }
    }

    private var hasChanges: Bool {
        guard let original = capture?.effectiveEvent else { return false }
        return changedFields(from: original).isEmpty == false
    }

    /// The fields to PATCH. An untouched seeded start date counts only when
    /// `includingSeededDate` is set (approve), so Save never records today as
    /// a correction the user didn't make.
    private func changedFields(from original: ExtractedEvent,
                               includingSeededDate: Bool = false) -> [String: String?] {
        var changes: [String: String?] = [:]
        func diff(_ key: String, _ old: String?, _ new: String?) {
            let normalizedNew = (new?.isEmpty == true) ? nil : new
            if normalizedNew != old { changes[key] = normalizedNew }
        }
        diff("title", original.title, form.title)
        diff("venue", original.venue, form.venue)
        diff("address", original.address, form.address)
        let untouchedSeed = seededStartDate != nil && form.startDate == seededStartDate
        if includingSeededDate || !untouchedSeed {
            diff("start_date", original.startDate, form.startDate)
        }
        diff("end_date", original.endDate, form.endDate)
        diff("start_time", original.startTime, form.startTime)
        diff("end_time", original.endTime, form.endTime)
        diff("url", original.url, form.url)
        return changes
    }

    private func save() async {
        guard let original = capture?.effectiveEvent else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            apply(try await appState.api.updateCapture(
                id: captureId, fields: changedFields(from: original)))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await appState.refreshCaptures()
        } catch {
            errorMessage = appState.message(for: error)
        }
    }

    private func delete(deleteEvent: Bool) async {
        do {
            try await appState.api.deleteCapture(id: captureId, deleteEvent: deleteEvent)
            await appState.refreshCaptures()
            dismiss()
        } catch {
            errorMessage = appState.message(for: error)
        }
    }

    /// Runs Google sign-in over this sheet rather than the library, so the
    /// form and any unsaved edits stay. A success clears `needsReauth`. A
    /// failure shows here, because the library's "Couldn't reconnect" alert
    /// can't present while the sheet is up. A cancel shows nothing.
    private func reconnect() async {
        guard let top = UIApplication.shared.topViewController else { return }
        await appState.signIn(presenting: top)
        if let failure = appState.signInError {
            appState.signInError = nil
            errorMessage = "Couldn't reconnect. \(failure)"
        }
    }

    /// Binds an optional String model field to a TextField.
    private func binding(_ keyPath: WritableKeyPath<ExtractedEvent, String?>) -> Binding<String> {
        Binding(
            get: { form[keyPath: keyPath] ?? "" },
            set: { form[keyPath: keyPath] = $0 }
        )
    }
}

private enum ImageState {
    case loading
    /// The store returns nil for any failure (network, expired URL, bad data).
    case failed
    case loaded(UIImage)
}

/// Identifiable wrapper so the full-screen image viewer can be presented with
/// `.fullScreenCover(item:)` — the image value is carried into the presentation
/// atomically, avoiding the empty-cover race of the `isPresented` form.
private struct ViewerImage: Identifiable {
    let id = UUID()
    let image: Image
}

/// A signal-strength-style meter for the AI's extraction confidence. Replaces
/// the old plain "Confidence: low" caption. The level is shown purely by how many
/// bars are lit — `high`/`medium`/`low` → 3/2/1 — and every lit bar shares one
/// colour, so the count does the work and the colour never reads as a status.
/// System indigo (adaptive in dark mode) is deliberately distinct from every
/// `StatusBadge` colour and from the app's blue-grey tint.
struct ConfidenceMeter: View {
    let confidence: String

    /// 1…3. Mirrors the backend's coercion (`pipeline/extract.ts`): anything
    /// unrecognised degrades to `low`.
    private var level: Int {
        switch confidence.lowercased() {
        case "high": return 3
        case "medium": return 2
        default: return 1
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text("Confidence")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(1...3, id: \.self) { bar in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(bar <= level ? Color.indigo : Color.secondary.opacity(0.25))
                        .frame(width: 4, height: 3 + CGFloat(bar) * 3)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Confidence: \(confidence)")
    }
}

