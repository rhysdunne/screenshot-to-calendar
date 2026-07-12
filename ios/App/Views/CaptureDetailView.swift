import SwiftUI

/// Source image + editable event fields. Saving PATCHes only changed fields;
/// the backend records each change as a correction and updates the calendar.
struct CaptureDetailView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let captureId: String

    @State private var capture: Capture?
    @State private var imageURL: URL?
    @State private var loadedImage: Image?
    @State private var showImageViewer = false
    @State private var form = ExtractedEvent()
    @State private var isSaving = false
    @State private var showDeleteConfirm = false
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
                    Button("Close") { dismiss() }
                }
            }
            .task { await load() }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .confirmationDialog("Delete this capture?", isPresented: $showDeleteConfirm) {
                Button("Delete capture and calendar event", role: .destructive) {
                    Task { await delete(deleteEvent: true) }
                }
                Button("Delete capture only", role: .destructive) {
                    Task { await delete(deleteEvent: false) }
                }
            }
            // Presented from Form level, like the alert/dialog above — a
            // fullScreenCover attached inside a Form row can present an empty
            // (black) cover because the row's host may be detached when the
            // presentation fires.
            .fullScreenCover(isPresented: $showImageViewer) {
                if let loadedImage {
                    ImageViewerView(image: loadedImage)
                }
            }
        }
    }

    private var imageSection: some View {
        Section {
            AsyncImage(url: imageURL) { phase in
                if case .success(let image) = phase {
                    image.resizable().aspectRatio(contentMode: .fit)
                        // Stash the decoded image for the full-screen viewer —
                        // it must not re-fetch the URL (presign expires in 5 min).
                        .onAppear { loadedImage = image }
                } else {
                    Rectangle().fill(.quaternary).frame(height: 200)
                }
            }
            .listRowInsets(EdgeInsets())
            .contentShape(Rectangle())
            .onTapGesture {
                if loadedImage != nil { showImageViewer = true }
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens the image full screen")
        }
    }

    private func statusSection(_ capture: Capture) -> some View {
        Section {
            HStack {
                StatusBadge(status: capture.status)
                Spacer()
                if let confidence = capture.event?.confidence {
                    Text("Confidence: \(confidence)").font(.caption).foregroundStyle(.secondary)
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
                Text(error).font(.callout).foregroundStyle(.red)
            }
            if capture.possibleDuplicateOf != nil {
                Label("Might duplicate an existing event — check your calendar.",
                      systemImage: "exclamationmark.triangle")
                    .font(.callout)
            }
        }
    }

    private var fieldsSection: some View {
        Section("Event details") {
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
                LabeledContent("Category") { Text(category.replacingOccurrences(of: "_", with: " ")) }
            }
        }
    }

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
                set: { form.endDate = $0 ? (form.endDate ?? form.startDate ?? WireFormat.date.string(from: Date())) : nil })
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
                        .fontWeight(.semibold)
                }
                .disabled(isSaving || hasChanges) // save edits first, then approve
                if hasChanges {
                    Text("Save your edits first, then add to calendar.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
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

    private func approve() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await appState.api.approveCapture(id: captureId)
            capture = updated
            form = updated.effectiveEvent ?? form
            await appState.refreshCaptures()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Data

    private func load() async {
        do {
            let loaded = try await appState.api.getCapture(id: captureId)
            capture = loaded
            form = loaded.effectiveEvent ?? ExtractedEvent()
            // A calendar event needs a date; if the extraction had none, seed
            // today so the always-visible Start date picker has a value to edit.
            if loaded.event != nil, form.startDate == nil {
                form.startDate = WireFormat.date.string(from: Date())
            }
            if let response = try? await appState.api.imageUrl(id: captureId) {
                imageURL = URL(string: response.url)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var hasChanges: Bool {
        guard let original = capture?.effectiveEvent else { return false }
        return changedFields(from: original).isEmpty == false
    }

    private func changedFields(from original: ExtractedEvent) -> [String: String?] {
        var changes: [String: String?] = [:]
        func diff(_ key: String, _ old: String?, _ new: String?) {
            let normalizedNew = (new?.isEmpty == true) ? nil : new
            if normalizedNew != old { changes[key] = normalizedNew }
        }
        diff("title", original.title, form.title)
        diff("venue", original.venue, form.venue)
        diff("address", original.address, form.address)
        diff("start_date", original.startDate, form.startDate)
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
            let updated = try await appState.api.updateCapture(
                id: captureId, fields: changedFields(from: original))
            capture = updated
            form = updated.effectiveEvent ?? form
            await appState.refreshCaptures()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(deleteEvent: Bool) async {
        do {
            try await appState.api.deleteCapture(id: captureId, deleteEvent: deleteEvent)
            await appState.refreshCaptures()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
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
