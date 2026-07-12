import SwiftUI

/// The kōkako brand palette, backed by colour sets in `Shared/Assets.xcassets`
/// so both the app and the share extension resolve them from their own bundle.
/// Named lookups (not generated asset symbols) keep behaviour deterministic
/// across `xcodegen generate` runs.
extension Color {
    /// Blue-grey (#607585), the app-wide tint; lightens to #93A9BA in dark mode.
    static let brandTint = Color("BrandTint")
    /// Kōwhai-gold accent (#E0AD4B). Legible on light and dark grounds at icon
    /// sizes — don't use it for small text.
    static let brandGold = Color("BrandGold")
}
