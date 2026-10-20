import Foundation
import Security

enum BroadcastSettings {
  private static var query: [String: Any] {
    var result: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "SI-DEMON-TV",
      kSecAttrAccount as String: "relay",
    ]
    if let group = Bundle.main.object(forInfoDictionaryKey: "DemonKeychainGroup") as? String,
      !group.contains("$(")
    {
      result[kSecAttrAccessGroup as String] = group
    }
    return result
  }
  private static var stored: [String: String] {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return [:] }
    return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
  }
  static var relay: String {
    stored["relay"] ?? Bundle.main.object(forInfoDictionaryKey: "DemonDefaultRelayURL") as? String
      ?? ""
  }
  static var key: String { stored["key"] ?? "" }
  @discardableResult static func save(relay: String, key: String) -> Bool {
    guard
      let data = try? JSONEncoder().encode([
        "relay": relay.trimmingCharacters(in: .whitespacesAndNewlines),
        "key": key.trimmingCharacters(in: .whitespacesAndNewlines),
      ])
    else { return false }
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      return SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        == errSecSuccess
    }
    return status == errSecSuccess
  }
  static func socketURL() -> URL? {
    guard var c = URLComponents(string: relay), ["https", "http"].contains(c.scheme), c.host != nil,
      c.user == nil, c.password == nil, !key.isEmpty
    else { return nil }
    c.scheme = c.scheme == "https" ? "wss" : "ws"
    c.path = c.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/ws/broadcast"
    if !c.path.hasPrefix("/") { c.path = "/" + c.path }
    c.queryItems = [URLQueryItem(name: "token", value: key)]
    c.fragment = nil
    return c.url
  }
}
