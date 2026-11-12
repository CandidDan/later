import Auth
import Foundation
import Security

protocol SessionStorageClearing: AuthLocalStorage {
  func clearAll() throws
}

protocol KeychainBackend: Sendable {
  func add(_ attributes: [String: Any]) -> OSStatus
  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
  func copy(_ query: [String: Any]) -> (OSStatus, Data?)
  func delete(_ query: [String: Any]) -> OSStatus
}

struct SystemKeychainBackend: KeychainBackend {
  func add(_ attributes: [String: Any]) -> OSStatus {
    SecItemAdd(attributes as CFDictionary, nil)
  }

  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
  }

  func copy(_ query: [String: Any]) -> (OSStatus, Data?) {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    return (status, result as? Data)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}

/// Supabase stores both its session and its PKCE verifier here, never in user defaults.
struct KeychainSessionStorage: SessionStorageClearing {
  enum StorageError: Error, Equatable {
    case missingAccessGroup
    case operationFailed(OSStatus)
    case invalidStoredData
  }

  static let service = "now.notfor.later.auth"
  let accessGroup: String?
  private let backend: any KeychainBackend

  init(
    accessGroup: String?, allowUnsignedDebugSimulator: Bool = false,
    backend: any KeychainBackend = SystemKeychainBackend()
  ) throws {
    self.accessGroup = try Self.resolvedAccessGroup(
      accessGroup, allowUnsignedDebugSimulator: allowUnsignedDebugSimulator)
    self.backend = backend
  }

  static func resolvedAccessGroup(
    _ accessGroup: String?, allowUnsignedDebugSimulator: Bool
  ) throws -> String? {
    #if DEBUG && targetEnvironment(simulator)
      if allowUnsignedDebugSimulator { return nil }
    #endif
    guard let accessGroup, !accessGroup.isEmpty, !accessGroup.contains("$("),
      accessGroup.hasSuffix(".now.notfor.later.shared")
    else { throw StorageError.missingAccessGroup }
    return accessGroup
  }

  func store(key: String, value: Data) throws {
    let query = query(key: key)
    let values: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = backend.update(query, attributes: values)
    if updated == errSecItemNotFound {
      let added = backend.add(query.merging(values) { _, new in new })
      // Another writer may have inserted this item between update and add.
      if added == errSecDuplicateItem {
        try check(backend.update(query, attributes: values))
      } else {
        try check(added)
      }
    } else {
      try check(updated)
    }
  }

  func retrieve(key: String) throws -> Data? {
    var query = query(key: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let (status, data) = backend.copy(query)
    if status == errSecItemNotFound { return nil }
    try check(status)
    guard let data else { throw StorageError.invalidStoredData }
    return data
  }

  func remove(key: String) throws {
    try checkDeletion(backend.delete(query(key: key)))
  }

  /// Deletes this service only, including any interrupted PKCE sign-in.
  func clearAll() throws {
    try checkDeletion(backend.delete(query(key: nil)))
  }

  private func query(key: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrSynchronizable as String: false,
    ]
    if let key { query[kSecAttrAccount as String] = key }
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  private func check(_ status: OSStatus) throws {
    guard status == errSecSuccess else { throw StorageError.operationFailed(status) }
  }

  private func checkDeletion(_ status: OSStatus) throws {
    if status != errSecItemNotFound { try check(status) }
  }
}
