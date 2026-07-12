import UIKit

/// In-memory image cache keyed by captureId. Fixes the grid flicker (#75):
/// every fetch mints a fresh presigned S3 URL, so URL-keyed caches (URLCache
/// under AsyncImage) can never hit — the decoded image must be cached against
/// the capture instead. NSCache evicts under memory pressure; images are also
/// capped by an approximate byte budget below.
@MainActor
final class CaptureImageStore {
    private let api: APIClient
    private let cache = NSCache<NSString, UIImage>()
    /// One fetch per capture at a time — a tile and the detail sheet asking
    /// for the same image await a single request instead of racing.
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init(api: APIClient) {
        self.api = api
        // Uploads are resized to ≤1000px, so a decoded image is ~4–5MB of
        // bitmap; 64MB keeps roughly the last dozen captures warm.
        cache.totalCostLimit = 64 * 1024 * 1024
    }

    /// The capture's image, from cache or the network. Returns nil on any
    /// failure — callers keep their placeholder, and the next request retries
    /// because failures are never cached.
    func image(for captureId: String) async -> UIImage? {
        if let cached = cache.object(forKey: captureId as NSString) { return cached }
        if let running = inFlight[captureId] { return await running.value }

        let task = Task<UIImage?, Never> { [api] in
            guard let response = try? await api.imageUrl(id: captureId),
                  let url = URL(string: response.url),
                  let (data, _) = try? await URLSession.shared.data(from: url)
            else { return nil }
            return UIImage(data: data)
        }
        inFlight[captureId] = task
        let image = await task.value
        inFlight[captureId] = nil

        if let image {
            let cost = Int(image.size.width * image.scale * image.size.height * image.scale) * 4
            cache.setObject(image, forKey: captureId as NSString, cost: cost)
        }
        return image
    }

    /// Drop everything — called on sign-out so another account's images can't
    /// leak across sessions.
    func removeAll() {
        cache.removeAllObjects()
        inFlight.values.forEach { $0.cancel() }
        inFlight = [:]
    }
}
