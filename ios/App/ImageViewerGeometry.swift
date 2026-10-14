import Foundation

// The full-screen image viewer's pan bounds. Foundation only, with no SwiftUI,
// so the Screenshot2CalTests target (ios/Tests/) compiles it on its own.
//
// The viewer scales its image about the centre of the container, then offsets
// it. The bounds come from the fitted image. Bounds taken from the container
// let a letterboxed image pan into black, or fully off screen (#145).

enum ImageViewerGeometry {
    /// The image's size at fit scale: aspect-fit inside `container`, less
    /// `inset` on each side. An image with no size fills that space.
    static func fittedSize(of image: CGSize, in container: CGSize, inset: CGFloat) -> CGSize {
        let space = CGSize(width: max(0, container.width - 2 * inset),
                           height: max(0, container.height - 2 * inset))
        guard image.width > 0, image.height > 0 else { return space }
        let ratio = min(space.width / image.width, space.height / image.height)
        return CGSize(width: image.width * ratio, height: image.height * ratio)
    }

    /// `offset`, bounded so the edges of the scaled image stop at the edges
    /// of the container. On an axis where the scaled image is smaller than
    /// the container, the bound is 0, so the image stays centred.
    static func clampedOffset(_ offset: CGSize, fitted: CGSize, scale: CGFloat,
                              in container: CGSize) -> CGSize {
        let maxX = max(0, (fitted.width * scale - container.width) / 2)
        let maxY = max(0, (fitted.height * scale - container.height) / 2)
        return CGSize(width: min(max(offset.width, -maxX), maxX),
                      height: min(max(offset.height, -maxY), maxY))
    }
}
