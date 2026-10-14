import SwiftUI

/// Full-screen zoomable viewer for a capture's source image, so small poster
/// text (dates, times, venues) can be read during review.
/// Receives the already-decoded Image from CaptureDetailView rather than a
/// URL — the presigned S3 GET URL expires after 300s, so re-fetching here
/// would 403 on a stale detail page.
struct ImageViewerView: View {
    @Environment(\.dismiss) private var dismiss
    let image: Image
    /// The image's size, for the pan bounds. A SwiftUI Image does not expose it.
    let imageSize: CGSize

    /// Padding between the image and its outline, on each side.
    private static let outlineInset: CGFloat = 1
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

    // Most captures are screenshots with their own status bar, X and "..."
    // buttons. A close button drawn over the image was hard to tell from
    // them, so the app's controls sit in a bar above the image instead. The
    // real status bar shows above that bar, so the screenshot's own clock
    // and battery no longer pass for the phone's.
    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    // A thin outline just outside the image marks where the
                    // picture ends, even when its top is as black as the
                    // background. It goes when zoomed, as scaleEffect would
                    // thicken it.
                    .padding(Self.outlineInset)
                    .border(Color.white.opacity(scale > 1 ? 0 : 0.3), width: 1)
                    .frame(width: geo.size.width, height: geo.size.height)
                    // Gestures work from the margins beside the image too.
                    .contentShape(Rectangle())
                    // Scale first, then offset, so pan works in screen points.
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(doubleTap)
                    .gesture(magnify(in: geo.size))
                    .simultaneousGesture(pan(in: geo.size))
            }
            // Keeps a zoomed image inside the fit area: below the bar and
            // above the home indicator.
            .clipped()
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Original image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(.secondarySystemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                // A word, not an xmark: screenshots are full of X glyphs.
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: Gestures
    //
    // Zoom is about the view center, not the pinch/tap point. Anchor-correct
    // zoom could build on ImageViewerGeometry.fittedSize. Revisit it, or a
    // UIScrollView bridge, only if the feel demands it on device.

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

    /// Bounds pan so the image's edges stop at the container's edges, with no
    /// black beside a letterboxed image (#145). An image smaller than the
    /// container on an axis stays centred on that axis.
    private func clampedOffset(_ o: CGSize, in size: CGSize) -> CGSize {
        let fitted = ImageViewerGeometry.fittedSize(of: imageSize, in: size,
                                                    inset: Self.outlineInset)
        return ImageViewerGeometry.clampedOffset(o, fitted: fitted, scale: scale, in: size)
    }
}
