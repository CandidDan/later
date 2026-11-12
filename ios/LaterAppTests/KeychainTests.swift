import Foundation
import Security
import XCTest

@testable import Later

final class KeychainTests: XCTestCase {
  private let group = "TEAMID.now.notfor.later.shared"

  func testNewItemUsesAfterFirstUnlockThisDeviceOnlyAndSharedGroup() throws {
    let backend = RecordingKeychain()
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    let data = Data("session".utf8)
    try storage.store(key: "session", value: data)
    let attributes = try XCTUnwrap(backend.added.first)
    XCTAssertEqual(
      attributes[kSecAttrAccessible as String] as? String,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    XCTAssertEqual(attributes[kSecAttrAccessGroup as String] as? String, group)
    XCTAssertEqual(attributes[kSecAttrService as String] as? String, KeychainSessionStorage.service)
    XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
    XCTAssertEqual(attributes[kSecValueData as String] as? Data, data)
  }

  func testUpdatePreservesAccessibilityWithoutDeletingSession() throws {
    let backend = RecordingKeychain(updateStatus: errSecSuccess)
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    try storage.store(key: "session", value: Data("replacement".utf8))
    XCTAssertTrue(backend.added.isEmpty)
    XCTAssertTrue(backend.deleted.isEmpty)
    let values = try XCTUnwrap(backend.updated.first)
    XCTAssertEqual(
      values[kSecAttrAccessible as String] as? String,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
  }

  func testMissingEntitlementDoesNotFallBackToDefaultGroup() throws {
    let backend = RecordingKeychain(updateStatus: errSecMissingEntitlement)
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    XCTAssertThrowsError(try storage.store(key: "session", value: Data())) { error in
      XCTAssertEqual(
        error as? KeychainSessionStorage.StorageError, .operationFailed(errSecMissingEntitlement))
    }
    XCTAssertTrue(backend.added.isEmpty)
  }

  func testMissingOrUnexpandedGroupIsRejectedWithoutUnsignedFlag() {
    for group in [nil, "", "$(AppIdentifierPrefix)now.notfor.later.shared", "wrong.group"] {
      XCTAssertThrowsError(try KeychainSessionStorage(accessGroup: group))
    }
  }

  func testUnsignedFallbackIsRestrictedToDebugSimulator() throws {
    #if DEBUG && targetEnvironment(simulator)
      let storage = try KeychainSessionStorage(
        accessGroup: group, allowUnsignedDebugSimulator: true, backend: RecordingKeychain())
      XCTAssertNil(storage.accessGroup)
    #else
      XCTAssertThrowsError(
        try KeychainSessionStorage(accessGroup: nil, allowUnsignedDebugSimulator: true))
    #endif
  }

  func testClearAllDeletesOnlyThisAuthServiceAndGroup() throws {
    let backend = RecordingKeychain()
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    try storage.clearAll()
    let query = try XCTUnwrap(backend.deleted.first)
    XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
    XCTAssertEqual(query[kSecAttrService as String] as? String, KeychainSessionStorage.service)
    XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, group)
    XCTAssertNil(query[kSecAttrAccount as String])
  }

  func testReadReturnsDataAndMissingReturnsNil() throws {
    let data = Data("session".utf8)
    let backend = RecordingKeychain(copyStatus: errSecSuccess, data: data)
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    XCTAssertEqual(try storage.retrieve(key: "session"), data)
    let missing = try KeychainSessionStorage(accessGroup: group, backend: RecordingKeychain())
    XCTAssertNil(try missing.retrieve(key: "missing"))
  }

  func testReadAndDeleteFailuresSurface() throws {
    let backend = RecordingKeychain(
      copyStatus: errSecInteractionNotAllowed, deleteStatus: errSecInteractionNotAllowed)
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    XCTAssertThrowsError(try storage.retrieve(key: "session"))
    XCTAssertThrowsError(try storage.clearAll())
    XCTAssertThrowsError(try storage.remove(key: "session"))
  }

  func testInvalidStoredValueIsNotTreatedAsAbsent() throws {
    let storage = try KeychainSessionStorage(
      accessGroup: group, backend: RecordingKeychain(copyStatus: errSecSuccess))
    XCTAssertThrowsError(try storage.retrieve(key: "session")) { error in
      XCTAssertEqual(error as? KeychainSessionStorage.StorageError, .invalidStoredData)
    }
  }

  func testRemovingMissingItemSucceedsAndTargetsOnlyThatKey() throws {
    let backend = RecordingKeychain(deleteStatus: errSecItemNotFound)
    let storage = try KeychainSessionStorage(accessGroup: group, backend: backend)
    try storage.remove(key: "verifier")
    XCTAssertEqual(backend.deleted.first?[kSecAttrAccount as String] as? String, "verifier")
    try storage.clearAll()
  }
}

/// Every mutable field is protected by the lock; Security's interface is synchronous.
private final class RecordingKeychain: KeychainBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var additions: [[String: Any]] = []
  private var updates: [[String: Any]] = []
  private var deletions: [[String: Any]] = []
  private let updateStatus: OSStatus
  private let copyStatus: OSStatus
  private let deleteStatus: OSStatus
  private let data: Data?

  var added: [[String: Any]] { lock.withLock { additions } }
  var updated: [[String: Any]] { lock.withLock { updates } }
  var deleted: [[String: Any]] { lock.withLock { deletions } }

  init(
    updateStatus: OSStatus = errSecItemNotFound, copyStatus: OSStatus = errSecItemNotFound,
    deleteStatus: OSStatus = errSecSuccess, data: Data? = nil
  ) {
    self.updateStatus = updateStatus
    self.copyStatus = copyStatus
    self.deleteStatus = deleteStatus
    self.data = data
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    lock.withLock { additions.append(attributes) }
    return errSecSuccess
  }

  func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
    lock.withLock { updates.append(attributes) }
    return updateStatus
  }

  func copy(_ query: [String: Any]) -> (OSStatus, Data?) {
    (copyStatus, data)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    lock.withLock { deletions.append(query) }
    return deleteStatus
  }
}
