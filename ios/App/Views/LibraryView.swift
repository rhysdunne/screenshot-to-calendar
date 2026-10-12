import SwiftUI

/// The capture library: a grid of shared images with status badges.
struct LibraryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedCapture: Capture?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if appState.captures.isEmpty {
                    emptyState
                } else if reviewCaptures.isEmpty {
                    // Nothing needs attention — show the flat grid, no section
                    // headers, so the tidy common case looks unchanged.
                    grid(recentCaptures).padding()
                } else {
                    VStack(alignment: .leading, spacing: 24) {
                        titledSection("Needs your review (\(reviewCaptures.count))", reviewCaptures)
                        titledSection("Recent", recentCaptures)
                    }
                    .padding()
                }
            }
            .navigationTitle("Captures")
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
            .onChange(of: scenePhase) { _, phase in
                // The share extension can't wake the app; refresh + poll when
                // the user comes back after sharing.
                if phase == .active {
                    Task {
                        await appState.refreshCaptures()
                        await appState.pollWhileProcessing()
                    }
                }
            }
            .onChange(of: appState.pendingDeepLinkCaptureId) { _, captureId in
                guard let captureId else { return }
                appState.pendingDeepLinkCaptureId = nil
                selectedCapture = appState.captures.first { $0.captureId == captureId }
                    ?? Capture(captureId: captureId, status: .completed, createdAt: "")
            }
        }
    }

    // MARK: Triage

    /// Captures that need the user to act: low-confidence extractions, failures
    /// that still produced an event to salvage, or possible duplicates. These
    /// float to the top so they don't scroll out of sight in reverse-chron order.
    private func needsAttention(_ capture: Capture) -> Bool {
        capture.status == .needsReview
            || (capture.status == .failed && capture.event != nil)
            || capture.possibleDuplicateOf != nil
    }

    private var reviewCaptures: [Capture] { appState.captures.filter(needsAttention) }
    private var recentCaptures: [Capture] { appState.captures.filter { !needsAttention($0) } }

    @ViewBuilder private func grid(_ captures: [Capture]) -> some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(captures) { capture in
                Button { selectedCapture = capture } label: {
                    CaptureTile(capture: capture)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// A labelled grid, rendered only when it has content (so an all-in-review
    /// state doesn't leave an empty "Recent" header behind).
    @ViewBuilder private func titledSection(_ title: String, _ captures: [Capture]) -> some View {
        if !captures.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.headline)
                grid(captures)
            }
        }
    }

    /// Sized to the scroll view's visible height so it sits centred, but still
    /// inside the ScrollView so pull-to-refresh works with zero captures.
    private var emptyState: some View {
        ContentUnavailableView {
            Label("No captures yet", systemImage: "photo.on.rectangle")
        } description: {
            Text("Screenshot an event poster or post, then share the screenshot and pick “Capture Event”.")
        }
        .containerRelativeFrame(.vertical)
    }
}

struct CaptureTile: View {
    @EnvironmentObject private var appState: AppState
    let capture: Capture
    @State private var image: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The image lives in an overlay of a fixed-height spacer so it can
            // never drive layout: a fill-mode image with only its height fixed
            // reports width = 130 × aspect, and one landscape photo would
            // inflate its grid cell until the row clipped off the screen edge.
            Color.clear
                .frame(height: 130)
                .overlay {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Rectangle().fill(.quaternary)
                            .overlay { Image(systemName: "photo").foregroundStyle(.secondary) }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10))
                // A duplicate is an echo of a capture you already have — dim
                // its thumbnail so the original reads as the real one.
                .opacity(capture.status == .duplicate ? 0.55 : 1)
                // Badge only when something is off — completed tiles (the
                // common case) stay clean, so badged ones read as "needs a
                // look". Applied after .opacity so the badge stays full-strength.
                .overlay(alignment: .topTrailing) {
                    if capture.status != .completed {
                        StatusBadge(status: capture.status, style: .overlay)
                            .padding(6)
                    }
                }

            Text(capture.effectiveEvent?.title ?? capture.status.label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
        }
        .task {
            image = await appState.images.image(for: capture.captureId)
        }
    }
}

struct StatusBadge: View {
    let status: CaptureStatus
    var style: Style = .tinted

    enum Style {
        /// Translucent capsule, coloured text — for flat grounds like Form rows.
        case tinted
        /// Solid capsule, white text — stays legible overlaid on a photo.
        case overlay
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(style == .overlay ? color : color.opacity(0.15), in: Capsule())
            .foregroundStyle(style == .overlay ? .white : color)
    }

    /// Overlay badges sit on ~110pt tiles; the two long labels get compact
    /// forms there ("Already in calendar" truncated mid-word on device).
    private var label: String {
        guard style == .overlay else { return status.label }
        switch status {
        case .duplicate: return "Duplicate"
        case .notEvent: return "Not an event"
        default: return status.label
        }
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

#Preview("StatusBadge styles") {
    let statuses: [CaptureStatus] = [
        .queued, .processing, .needsReview, .failed, .duplicate, .notEvent, .completed,
    ]
    return HStack(alignment: .top, spacing: 24) {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(statuses, id: \.self) { StatusBadge(status: $0) }
        }
        // Overlay style on a photo-ish ground, as on a capture tile.
        VStack(alignment: .leading, spacing: 8) {
            ForEach(statuses, id: \.self) { StatusBadge(status: $0, style: .overlay) }
        }
        .padding(8)
        .background(LinearGradient(colors: [.brown, .teal],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
    .padding()
}
