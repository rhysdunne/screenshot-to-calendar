import Foundation

/// Central configuration shared by the app and the share extension.
/// After deploying the backend, paste the API endpoint(s) and CloudFront
/// domain here (values are printed by `cdk deploy` as stack outputs).
enum AppConfig {
    /// API Gateway endpoint for the prod stack, e.g. "https://abc123.execute-api.eu-west-2.amazonaws.com"
    static let prodApiBase = URL(string: "https://REPLACE_ME_PROD_API.execute-api.eu-west-2.amazonaws.com")!
    /// Staging endpoint — used automatically by Debug builds.
    static let stagingApiBase = URL(string: "https://REPLACE_ME_STAGING_API.execute-api.eu-west-2.amazonaws.com")!

    static var apiBase: URL {
        #if DEBUG
        return stagingApiBase
        #else
        return prodApiBase
        #endif
    }

    /// The CloudFront web domain (universal links host), without scheme.
    static let webDomain = "REPLACE_ME_CLOUDFRONT_DOMAIN"

    static let appGroupId = "group.com.rhysdunne.s2c"
    static let keychainAccessGroupSuffix = "com.rhysdunne.s2c.shared"

    /// Longest edge for images before upload — the v1 convention, kept because
    /// it keeps payloads ~300KB while remaining plenty for Claude vision.
    static let maxImageLongestEdge: CGFloat = 1000
    static let jpegQuality: CGFloat = 0.8
}
