import Foundation

/// Central configuration shared by the app and the share extension.
/// After deploying the backend, paste the API endpoint(s) and CloudFront
/// domain here (values are printed by `cdk deploy` as stack outputs).
enum AppConfig {
    /// API Gateway endpoint for the prod stack, e.g. "https://abc123.execute-api.eu-west-2.amazonaws.com"
    static let prodApiBase = URL(string: "https://6qnbz31qk6.execute-api.eu-west-2.amazonaws.com")!
    /// Staging endpoint — used automatically by Debug builds.
    static let stagingApiBase = URL(string: "https://fbwzvtz244.execute-api.eu-west-2.amazonaws.com")!

    static var apiBase: URL {
        #if DEBUG
        return stagingApiBase
        #else
        return prodApiBase
        #endif
    }

    /// The CloudFront web domain (universal links host), without scheme.
    static let webDomain = "d1n6hy34w2a6gq.cloudfront.net"

    /// Contact address for privacy/data-protection requests. Must match the
    /// controller contact named in privacy.html.
    static let supportEmail = "rhys.dunne@gmail.com"

    static let appGroupId = "group.digital.callaeas.s2c"
    static let keychainAccessGroupSuffix = "digital.callaeas.s2c.shared"

    /// Longest edge for images before upload — the v1 convention, kept because
    /// it keeps payloads ~300KB while remaining plenty for Claude vision.
    static let maxImageLongestEdge: CGFloat = 1000
    static let jpegQuality: CGFloat = 0.8
}
