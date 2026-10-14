import Foundation
import Testing

@Suite("ImageViewerGeometry")
struct ImageViewerGeometryTests {
    // The viewer's image area on a 393 x 852 pt iPhone: below the 59 pt
    // status bar and the 44 pt bar, above the 34 pt home indicator.
    let container = CGSize(width: 393, height: 715)

    @Test("The fitted size is aspect-fit inside the container, less the inset")
    func fitted() {
        // A portrait screenshot after the client resize: height-limited.
        let portrait = ImageViewerGeometry.fittedSize(
            of: CGSize(width: 461, height: 1000), in: container, inset: 1)
        #expect(isClose(portrait.height, 713))
        #expect(isClose(portrait.width, 461 * 0.713))
        // A 16:9 poster: width-limited.
        let landscape = ImageViewerGeometry.fittedSize(
            of: CGSize(width: 1000, height: 563), in: container, inset: 1)
        #expect(isClose(landscape.width, 391))
        #expect(isClose(landscape.height, 563 * 0.391))
    }

    @Test("An image with no size fills the space inside the inset")
    func noSize() {
        let fitted = ImageViewerGeometry.fittedSize(of: .zero, in: container, inset: 1)
        #expect(isClose(fitted.width, 391))
        #expect(isClose(fitted.height, 713))
    }

    @Test("At fit scale the image cannot move")
    func fitScale() {
        let fitted = ImageViewerGeometry.fittedSize(
            of: CGSize(width: 1000, height: 1000), in: container, inset: 1)
        let o = ImageViewerGeometry.clampedOffset(
            CGSize(width: 500, height: -500), fitted: fitted, scale: 1, in: container)
        #expect(o == .zero)
    }

    // #145: the old bounds came from the container, so at 5x a square poster
    // could pan 1,430 pt down and leave the screen. It now stops at 620 pt,
    // with its top edge at the top of the container.
    @Test("A square poster at 5x stops with its edges at the container's")
    func squareAtFiveTimes() {
        let fitted = ImageViewerGeometry.fittedSize(
            of: CGSize(width: 1000, height: 1000), in: container, inset: 1)
        let o = ImageViewerGeometry.clampedOffset(
            CGSize(width: 10_000, height: 10_000), fitted: fitted, scale: 5, in: container)
        #expect(isClose(o.width, (391 * 5 - 393) / 2))
        #expect(isClose(o.height, (391 * 5 - 715) / 2))
    }

    @Test("An axis where the scaled image is smaller than the container stays centred")
    func centredWhenSmaller() {
        // A 16:9 poster at 2.5x is about 978 pt wide but only 550 pt tall.
        let fitted = ImageViewerGeometry.fittedSize(
            of: CGSize(width: 1000, height: 563), in: container, inset: 1)
        let o = ImageViewerGeometry.clampedOffset(
            CGSize(width: -10_000, height: 10_000), fitted: fitted, scale: 2.5, in: container)
        #expect(isClose(o.width, -(391 * 2.5 - 393) / 2))
        #expect(o.height == 0)
    }

    // Shapes: portrait screenshot, 4:5 post, square, 16:9 poster.
    @Test("A pan past the limit never shows black beside the image",
          arguments: [461.0 / 1000, 4.0 / 5, 1, 1000.0 / 563], [1.5, 2.5, 5])
    func noGap(aspect: Double, scale: Double) {
        let fitted = ImageViewerGeometry.fittedSize(
            of: CGSize(width: aspect * 1000, height: 1000), in: container, inset: 1)
        let s = CGFloat(scale)
        for far in [CGSize(width: 10_000, height: 10_000),
                    CGSize(width: -10_000, height: -10_000)] {
            let o = ImageViewerGeometry.clampedOffset(far, fitted: fitted, scale: s, in: container)
            for (image, offset, area) in [(fitted.width, o.width, container.width),
                                          (fitted.height, o.height, container.height)] {
                if image * s >= area {
                    // One edge of the scaled image sits exactly at the
                    // container's edge, and the image covers the rest.
                    #expect(isClose(image * s / 2 - abs(offset), area / 2))
                } else {
                    #expect(offset == 0)
                }
            }
        }
    }
}

private func isClose(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.001 }
