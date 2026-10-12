import Foundation
import Security

/// A keychain write the system refused. Thrown, not ignored, so a broken
/// session store fails sign-in visibly instead of signing in with no token.
struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        "Couldn't save your session on this device (keychain error \(status)). Try signing in again."
    }
}

/// Session token storage in the shared keychain access group, so the share
/// extension can authenticate uploads without the app running.
enum KeychainStore {
    private static let service = "digital.callaeas.s2c.session"
    private static let account = "jwt"

    private static var accessGroup: String {
        // $(AppIdentifierPrefix) is resolved at runtime from the entitlement.
        // Bundle.main's TeamIdentifierPrefix isn't directly readable; keychain
        // APIs accept the group as written in the entitlements file.
        let prefix = (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String) ?? ""
        return prefix + AppConfig.keychainAccessGroupSuffix
    }

    /// Matches the item whatever its accessibility class, so reads, the update
    /// in `save` and `clear` still find a token written before the class
    /// changed. The class is not part of the item's identity, so there is only
    /// ever one item to match.
    private static func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if !targetEnvironment(simulator)
        // Access groups misbehave on the simulator; only set on device.
        query[kSecAttrAccessGroup as String] = accessGroup
        #endif
        return query
    }

    static var token: String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Replaces the stored token. Updates the item in place and adds one only
    /// when none exists, so a refused write leaves the previous token working
    /// (a delete then add would lose it if the add failed, signing a
    /// reconnecting user out). `ThisDeviceOnly` keeps the long-lived token out
    /// of backups, so it never moves to another device. A token saved under
    /// the old `AfterFirstUnlock` class stays readable, and the update moves
    /// it to the new class on the next sign-in.
    static func save(_ token: String) throws {
        let query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KeychainError(status: updated) }
        let added = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }

    /// Removes the stored token on sign-out. The status is not checked: there
    /// is no useful recovery, and a token left behind only keeps this device
    /// signed in until the backend rejects it.
    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
