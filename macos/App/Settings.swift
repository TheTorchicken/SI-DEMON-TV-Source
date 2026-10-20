import Foundation
import Security

enum MacSettings {
  private static let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "SI-DEMON-TV.Mac", kSecAttrAccount as String: "relay",
  ]
  static func load() -> (address: String, key: String) {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    if SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
      let values = try? JSONDecoder().decode([String: String].self, from: data)
    {
      return (values["address"] ?? "", values["key"] ?? "")
    }
    return (Bundle.main.object(forInfoDictionaryKey: "DemonDefaultRelayURL") as? String ?? "", "")
  }
  static func save(_ connection: RelayConnection) throws {
    let data = try JSONEncoder().encode([
      "address": connection.base.absoluteString, "key": connection.key,
    ])
    let values: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let result = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    let status =
      result == errSecItemNotFound
      ? SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil) : result
    guard status == errSecSuccess else {
      throw MirrorError.message("The connection could not be saved in Keychain.")
    }
  }
}
