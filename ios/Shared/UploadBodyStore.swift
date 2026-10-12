import Foundation

/// The share extension's upload bodies. A background URLSession can only
/// upload from a file, so each share writes its JSON body (the base64 image)
/// into the App Group container. Nothing tells the extension when an upload
/// ends, so old files are swept by age instead of deleted on completion.
enum UploadBodyStore {
    /// Uploads normally finish seconds after the share. A day leaves room
    /// for iOS to retry one that started with no network.
    private static let maxAge: TimeInterval = 24 * 3600

    private static var directory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppConfig.appGroupId)?
            .appendingPathComponent("uploads", isDirectory: true)
    }

    /// Writes a new body file and returns its URL, first deleting any body
    /// file older than a day.
    static func write(_ body: Data) throws -> URL {
        guard let directory else {
            throw NSError(domain: "s2c", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "App Group container unavailable",
            ])
        }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let cutoff = Date.now.addingTimeInterval(-maxAge)
        let files = (try? fm.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for file in files {
            let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate
            if let modified, modified < cutoff { try? fm.removeItem(at: file) }
        }
        let bodyFile = directory.appendingPathComponent("\(UUID().uuidString).json")
        try body.write(to: bodyFile)
        return bodyFile
    }

    /// Deletes every body file. Called on sign-out, so a shared image doesn't
    /// stay on the device after the session that sent it ends.
    static func removeAll() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
    }
}
