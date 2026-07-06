import UIKit

enum ImageResizer {
    /// Resize to the v1 convention (longest edge 1000px) and encode as JPEG.
    /// Keeps upload payloads ~300KB and stays inside the share extension's
    /// memory ceiling.
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
}
