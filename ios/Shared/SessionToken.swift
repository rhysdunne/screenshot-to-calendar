import Foundation

/// Reads the expiry of the app's session JWT. The signature is not checked:
/// the backend does that. This only lets the share extension spot a session
/// that is over before it queues an upload that can only fail, and lets the
/// app sign out at the same point so the two agree.
enum SessionToken {
    private struct Claims: Decodable {
        let exp: TimeInterval
    }

    /// The `exp` claim, or nil if the token's payload can't be decoded.
    static func expiry(of token: String) -> Date? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        // base64url → base64: swap the two URL-safe characters and restore padding.
        var base64 = parts[1].replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let payload = Data(base64Encoded: base64),
              let claims = try? JSONDecoder().decode(Claims.self, from: payload)
        else { return nil }
        return Date(timeIntervalSince1970: claims.exp)
    }

    /// True if the token has expired or expires within `margin` (an hour by
    /// default, so an upload iOS retries later doesn't land after expiry).
    /// False if the expiry can't be read, so an unexpected token format still
    /// uploads as before.
    static func expiresSoon(_ token: String, within margin: TimeInterval = 3600, now: Date = .now) -> Bool {
        guard let expiry = expiry(of: token) else { return false }
        return expiry.timeIntervalSince(now) < margin
    }
}
