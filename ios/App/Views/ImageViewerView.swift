import SwiftUI

/// Full-screen zoomable viewer for a capture's source image, so small poster
/// text (dates, times, venues) can be read during review.
/// Receives the already-decoded Image from CaptureDetailView rather than a
/// URL — the presigned S3 GET URL expires after 300s, so re-fetching here
/// would 403 on a stale detail page.
struct ImageViewerView: View {
    @Environment(\.dismiss) private var dismiss
    let image: Image

    private static let minScale: CGFloat = 1
    private static let maxScale: CGFloat = 5
    private static let doubleTapScale: CGFloat = 2.5
    /// Soft over-zoom allowed mid-gesture for a rubber-band feel; snaps back
    /// to the hard limits on release.
    private static let rubberBand: CGFloat = 1.3

    // `committed*` are the gesture-start baselines, updated only in onEnded;
    // `scale`/`offset` include the in-flight gesture. fullScreenCover builds
    // a fresh view per presentation, so everything resets on dismiss for free.
    @State private var scale: CGFloat = 1
    @State private var committedScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var committedOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.ignoresSafeArea()
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: geo.size.width, height: geo.size.height)
                    // Scale first, then offset, so pan works in screen points.
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(doubleTap)
                    .gesture(magnify(in: geo.size))
                    .simultaneousGesture(pan(in: geo.size))
            }
            .overlay(alignment: .topTrailing) { closeButton }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
    }

    // MARK: Gestures
    //
    // Zoom is about the view center, not the pinch/tap point — anchor-correct
    // zoom needs the fitted image's geometry (SwiftUI's Image doesn't expose
    // its pixel size). Revisit with a UIScrollView bridge only if the feel
    // demands it on device.

    private func magnify(in size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(committedScale * value.magnification,
                                Self.minScale / Self.rubberBand),
                            Self.maxScale * Self.rubberBand)
            }
            .onEnded { _ in
                withAnimation(.spring(duration: 0.3)) {
                    scale = min(max(scale, Self.minScale), Self.maxScale)
                    if scale <= Self.minScale { offset = .zero }
                    offset = clampedOffset(offset, in: size)
                }
                committedScale = scale
                committedOffset = offset
            }
    }

    private func pan(in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                guard scale > 1 else { return }
                offset = CGSize(width: committedOffset.width + value.translation.width,
                                height: committedOffset.height + value.translation.height)
            }
            .onEnded { value in
                if scale > 1 {
                    withAnimation(.spring(duration: 0.3)) {
                        offset = clampedOffset(offset, in: size)
                    }
                    committedOffset = offset
                } else if value.translation.height > 100 {
                    // At fit scale a generous downward swipe dismisses;
                    // fullScreenCover has no system swipe-down of its own.
                    dismiss()
                }
            }
    }

    private var doubleTap: some Gesture {
        TapGesture(count: 2).onEnded {
            withAnimation(.spring(duration: 0.3)) {
                if scale > 1 {
                    scale = 1
                    offset = .zero
                } else {
                    scale = Self.doubleTapScale
                }
            }
            committedScale = scale
            committedOffset = offset
        }
    }

    /// Bounds pan so the image can't be flung fully off screen. Uses the
    /// container as a proxy for the fitted image size — the letterboxed axis
    /// gets a little extra slack, acceptable since the intrinsic pixel size
    /// isn't available from a SwiftUI Image.
    private func clampedOffset(_ o: CGSize, in size: CGSize) -> CGSize {
        let maxX = max(0, size.width * (scale - 1) / 2)
        let maxY = max(0, size.height * (scale - 1) / 2)
        return CGSize(width: min(max(o.width, -maxX), maxX),
                      height: min(max(o.height, -maxY), maxY))
    }

    private var closeButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.title)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.white)
                .padding()
        }
        .accessibilityLabel("Close")
    }
}
