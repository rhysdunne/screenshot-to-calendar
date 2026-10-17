import Foundation

/// Builds backend API request URLs. It sits outside APIClient.swift, which
/// needs the keychain, so the Foundation-only test target can check it.
enum APIURL {
    /// `appending(path:)` percent-encodes "?", so a query written into `path`
    /// reaches the backend as part of the path. Pass it as `query` instead.
    static func make(_ base: URL, path: String, query: [URLQueryItem] = []) -> URL {
        assert(!path.contains("?"), "Pass the query as query items, not in the path: \(path)")
        let url = base.appending(path: path)
        // appending(queryItems: []) leaves a trailing "?".
        return query.isEmpty ? url : url.appending(queryItems: query)
    }
}
