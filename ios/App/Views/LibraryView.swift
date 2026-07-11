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

    private var emptyState: some View {
        VStack(spacing: 16) {
            Text("🗂️").font(.system(size: 56))
            Text("No captures yet").font(.headline)
            Text("Share an event poster or screenshot from Photos or Instagram and pick “Capture Event”.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 120)
        .padding(.horizontal, 40)
    }
}

struct CaptureTile: View {
    @EnvironmentObject private var appState: AppState
    let capture: Capture
    @State private var imageURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AsyncImage(url: imageURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                default:
                    Rectangle().fill(.quaternary)
                        .overlay { Image(systemName: "photo").foregroundStyle(.secondary) }
                }
            }
            .frame(height: 130)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            Text(capture.effectiveEvent?.title ?? capture.status.label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
            StatusBadge(status: capture.status)
        }
        .task {
            if let response = try? await appState.api.imageUrl(id: capture.captureId) {
                imageURL = URL(string: response.url)
            }
        }
    }
}

struct StatusBadge: View {
    let status: CaptureStatus

    var body: some View {
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
