import UIKit
import ImageIO

/// Resize to the v1 convention (longest edge 1000px) and encode as JPEG.
/// Keeps upload payloads ~300KB and stays inside the share extension's
/// memory ceiling.
enum ImageResizer {
    /// Downsamples an image file. See `downsampleAndEncode`.
    static func resizeAndEncode(
        contentsOf url: URL,
        maxLongestEdge: CGFloat = AppConfig.maxImageLongestEdge,
        quality: CGFloat = AppConfig.jpegQuality
    ) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else { return nil }
        return downsampleAndEncode(source, maxLongestEdge: maxLongestEdge, quality: quality)
    }

    /// Downsamples encoded image bytes. See `downsampleAndEncode`.
    static func resizeAndEncode(
        _ data: Data,
        maxLongestEdge: CGFloat = AppConfig.maxImageLongestEdge,
        quality: CGFloat = AppConfig.jpegQuality
    ) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        return downsampleAndEncode(source, maxLongestEdge: maxLongestEdge, quality: quality)
    }

    /// The fallback for an image that arrives already decoded, so its
    /// full-size bitmap is in memory before this runs.
    static func resizeAndEncode(
        _ image: UIImage,
        maxLongestEdge: CGFloat = AppConfig.maxImageLongestEdge,
        quality: CGFloat = AppConfig.jpegQuality
    ) -> Data? {
        let longest = max(image.size.width, image.size.height)
        guard longest > maxLongestEdge else {
            return image.jpegData(compressionQuality: quality)
        }
        let scale = maxLongestEdge / longest
        let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
        return resized.jpegData(compressionQuality: quality)
    }

    /// Don't keep a full-size decode cached on the source.
    private static let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary

    /// ImageIO decodes straight to the target size, so the full-size bitmap
    /// never exists: a 48 MP photo would need ~190 MB, past the extension's
    /// ~120 MB ceiling. The EXIF orientation is applied to the pixels, and an
    /// image already under the limit keeps its size.
    private static func downsampleAndEncode(
        _ source: CGImageSource,
        maxLongestEdge: CGFloat,
        quality: CGFloat
    ) -> Data? {
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxLongestEdge,
        ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: thumbnail).jpegData(compressionQuality: quality)
    }
}
