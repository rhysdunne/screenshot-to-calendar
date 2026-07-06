import SwiftUI

/// Source image + editable event fields. Saving PATCHes only changed fields;
/// the backend records each change as a correction and updates the calendar.
struct CaptureDetailView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let captureId: String

    @State private var capture: Capture?
    @State private var imageURL: URL?
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
                        actionsSection(capture)
                    }
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
        }
    }

    private var imageSection: some View {
        Section {
            AsyncImage(url: imageURL) { phase in
                if case .success(let image) = phase {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else {
                    Rectangle().fill(.quaternary).frame(height: 200)
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
                    Text("Confidence: \(confidence)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if capture.status == .needsReview {
                Text("The AI wasn't confident about these details — check them (especially the dates), fix anything wrong, then add to calendar below.")
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
            LabeledContent("Start date") {
                TextField("YYYY-MM-DD", text: binding(\.startDate))
                    .keyboardType(.numbersAndPunctuation)
            }
            LabeledContent("End date") {
                TextField("YYYY-MM-DD", text: binding(\.endDate))
                    .keyboardType(.numbersAndPunctuation)
            }
            LabeledContent("Start time") {
                TextField("HH:MM", text: binding(\.startTime))
                    .keyboardType(.numbersAndPunctuation)
            }
            LabeledContent("End time") {
                TextField("HH:MM", text: binding(\.endTime))
                    .keyboardType(.numbersAndPunctuation)
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

    private func actionsSection(_ capture: Capture) -> some View {
        Section {
            if capture.status == .needsReview || (capture.status == .failed && capture.event != nil) {
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
