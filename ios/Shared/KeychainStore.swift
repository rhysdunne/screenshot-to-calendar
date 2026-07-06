import Foundation
import Security

/// Session token storage in the shared keychain access group, so the share
/// extension can authenticate uploads without the app running.
enum KeychainStore {
    private static let service = "com.rhysdunne.s2c.session"
    private static let account = "jwt"

    private static var accessGroup: String {
        // $(AppIdentifierPrefix) is resolved at runtime from the entitlement.
        // Bundle.main's TeamIdentifierPrefix isn't directly readable; keychain
        // APIs accept the group as written in the entitlements file.
        let prefix = (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String) ?? ""
        return prefix + AppConfig.keychainAccessGroupSuffix
    }

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
        get {
            var query = baseQuery()
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
                  let data = item as? Data
            else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let query = baseQuery()
            SecItemDelete(query as CFDictionary)
            guard let newValue, let data = newValue.data(using: .utf8) else { return }
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
