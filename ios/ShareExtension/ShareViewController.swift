import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// The core interaction: share an image from Photos/Instagram/anywhere →
/// resize → upload → "Sent". The upload runs on a background URLSession
/// scoped to the App Group so it survives the extension being torn down
/// moments after completeRequest().
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
        guard let token = KeychainStore.token else {
            finish(.failure("Open Screenshot to Calendar and sign in first."), after: 2.5)
            return
        }
        // The backend would reject an expired token, but only after the
        // background upload, where nothing can tell the user. Say so now.
        guard !SessionToken.expiresSoon(token) else {
            finish(.failure("Session expired. Open Screenshot to Calendar to sign in."), after: 2.5)
            return
        }
        guard let jpeg = await loadSharedJPEG() else {
            finish(.failure("Couldn't read that image."), after: 2)
            return
        }
        do {
            try enqueueUpload(imageData: jpeg, token: token)
            finish(.success("Sent.\nCheck the app if it needs review."))
        } catch {
            finish(.failure("Upload failed: \(error.localizedDescription)"), after: 2.5)
        }
    }

    /// The first shared image, resized and encoded for upload.
    private func loadSharedJPEG() async -> Data? {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?
            .compactMap(\.attachments)
            .flatMap { $0 } ?? []
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let jpeg = try? await provider.loadUploadJPEG() {
                return jpeg
            }
        }
        return nil
    }

    /// Background upload: the request body is written to the App Group
    /// container and handed to a background URLSession, which iOS runs to
    /// completion even after this extension exits.
    private func enqueueUpload(imageData: Data, token: String) throws {
        let body = try JSONEncoder().encode(["imageBase64": imageData.base64EncodedString()])
        let bodyFile = try UploadBodyStore.write(body)

        var request = URLRequest(url: AppConfig.apiBase.appending(path: "/v1/captures"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let config = URLSessionConfiguration.background(
            withIdentifier: "digital.callaeas.s2c.upload.\(UUID().uuidString)")
        config.sharedContainerIdentifier = AppConfig.appGroupId
        config.isDiscretionary = false
        let session = URLSession(configuration: config)
        session.uploadTask(with: request, fromFile: bodyFile).resume()
    }
}

private extension NSItemProvider {
    /// Loads the shared image as an upload JPEG. A file or data item is
    /// downsampled without ever decoding at full size. The resize runs inside
    /// the callback, while the item's file URL is certain to be readable.
    func loadUploadJPEG() async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                switch item {
                case let url as URL:
                    continuation.resume(returning: ImageResizer.resizeAndEncode(contentsOf: url))
                case let data as Data:
                    continuation.resume(returning: ImageResizer.resizeAndEncode(data))
                case let image as UIImage:
                    // Some apps share an already decoded image.
                    continuation.resume(returning: ImageResizer.resizeAndEncode(image))
                default:
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
