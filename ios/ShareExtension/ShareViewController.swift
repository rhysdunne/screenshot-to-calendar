import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// The core interaction: share an image from Photos/Instagram/anywhere →
/// resize → upload → "Added, processing". The upload runs on a background
/// URLSession scoped to the App Group so it survives the extension being
/// torn down moments after completeRequest().
final class ShareViewController: UIViewController {
    private let model = ShareStatusModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureUI()
        Task { await handleSharedItem() }
    }

    /// Embed the SwiftUI status view full-bleed; the hosting view stays clear
    /// so the extension keeps its systemBackground ground.
    private func configureUI() {
        let host = UIHostingController(rootView: ShareStatusView(model: model))
        host.view.backgroundColor = .clear
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func finish(_ phase: ShareStatusModel.Phase, after seconds: Double = 1.2) {
        model.phase = phase
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func handleSharedItem() async {
        guard KeychainStore.token != nil else {
            finish(.failure("Open Screenshot to Calendar and sign in first."), after: 2.5)
            return
        }
        guard let image = await loadSharedImage() else {
            finish(.failure("Couldn't read that image."), after: 2)
            return
        }
        guard let jpeg = ImageResizer.resizeAndEncode(image) else {
            finish(.failure("Couldn't process that image."), after: 2)
            return
        }
        do {
            try enqueueUpload(imageData: jpeg)
            finish(.success("Added — processing.\nOpen the app to see the result."))
        } catch {
            finish(.failure("Upload failed: \(error.localizedDescription)"), after: 2.5)
        }
    }

    private func loadSharedImage() async -> UIImage? {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .compactMap(\.attachments)
            .flatMap { $0 } ?? []
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let image = try? await provider.loadImage() {
                return image
            }
        }
        return nil
    }

    /// Background upload: the request body is written to the App Group
    /// container and handed to a background URLSession, which iOS runs to
    /// completion even after this extension exits.
    private func enqueueUpload(imageData: Data) throws {
        let body = try JSONEncoder().encode(["imageBase64": imageData.base64EncodedString()])
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AppConfig.appGroupId
        ) else {
            throw NSError(domain: "s2c", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "App Group container unavailable",
            ])
        }
        let uploadsDir = container.appendingPathComponent("uploads", isDirectory: true)
        try FileManager.default.createDirectory(at: uploadsDir, withIntermediateDirectories: true)
        let bodyFile = uploadsDir.appendingPathComponent("\(UUID().uuidString).json")
        try body.write(to: bodyFile)

        var request = URLRequest(url: AppConfig.apiBase.appending(path: "/v1/captures"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = KeychainStore.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let config = URLSessionConfiguration.background(
            withIdentifier: "digital.callaeas.s2c.upload.\(UUID().uuidString)")
        config.sharedContainerIdentifier = AppConfig.appGroupId
        config.isDiscretionary = false
        let session = URLSession(configuration: config)
        session.uploadTask(with: request, fromFile: bodyFile).resume()
    }
}

private extension NSItemProvider {
    func loadImage() async throws -> UIImage? {
        try await withCheckedThrowingContinuation { continuation in
            loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                switch item {
                case let url as URL:
                    continuation.resume(returning: UIImage(contentsOfFile: url.path))
                case let data as Data:
                    continuation.resume(returning: UIImage(data: data))
                case let image as UIImage:
                    continuation.resume(returning: image)
                default:
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
