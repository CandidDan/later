import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class SavedCacheTests: XCTestCase {
  func testOfflineUsesLastFetchedPagesAndSignOutDeletesCacheAndQueue() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let auth = AuthService(
      backend: AuthTestSupport.Backend(signedIn: true, failRequests: false),
      storage: AuthTestSupport.Storage(),
      caches: UserCacheCleaner(directories: [
        parent.appendingPathComponent(UserCacheCleaner.directoryName)
      ]))
    await auth.restore()
    let userID = try XCTUnwrap(auth.session?.user.id)
    let cache = SavedFileCache(userID: userID, parent: parent)
    XCTAssertNil(try cache.read())
    let client = SavedAPIStub()
    let item = try SavedFixtures.item()
    let older = try SavedFixtures.item(date: "2026-11-10T12:00:00Z")
    await client.setPages(
      first: try SavedFixtures.page([item], cursor: "next"), next: try SavedFixtures.page([older]))
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    await model.loadNextPage()
    await client.setFailure(URLError(.notConnectedToInternet))
    _ = await model.perform(.consume, on: item)
    let offline = SavedViewModel(client: client, cache: cache)
    await offline.start()
    XCTAssertEqual(offline.items, [item, older])
    XCTAssertTrue(offline.isOffline)
    XCTAssertEqual(SavedViewModel.offlineNotice, "Offline — showing what you last loaded")
    XCTAssertEqual(offline.pendingCount, 1)
    let attributes = try FileManager.default.attributesOfItem(atPath: cache.file.path)
    XCTAssertEqual(
      attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
    XCTAssertEqual(
      try cache.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
      true)
    let other = SavedFileCache(userID: UUID(), parent: parent)
    XCTAssertNil(try other.read(), "Users must not share a cache")
    await auth.signOut()
    XCTAssertNil(auth.session)
    XCTAssertNil(try cache.read())
    XCTAssertFalse(FileManager.default.fileExists(atPath: cache.directory.path))
  }

  func testLateResponseCannotRecreateCacheAfterSignOut() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    var active = true
    let model = SavedViewModel(client: client, cache: cache, isActive: { active })
    await client.setDelay(50_000_000)
    await client.setPages(first: try SavedFixtures.page([SavedFixtures.item()]))
    let task = Task { await model.start() }
    while !model.isLoading { await Task.yield() }
    active = false
    await task.value
    XCTAssertEqual(cache.writes, 0)
    XCTAssertTrue(model.items.isEmpty)
    XCTAssertFalse(model.showEmpty)
    await model.retryPending()
    let result = await model.perform(.open, on: try SavedFixtures.item())
    XCTAssertNil(result)
  }

  func testLateActionCannotNavigateOrWriteAfterSessionEnds() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    var active = true
    let model = SavedViewModel(client: client, cache: cache, isActive: { active })
    await model.start()
    await client.setDelay(50_000_000)
    let item = try SavedFixtures.item()
    let task = Task { await model.perform(.open, on: item) }
    while !model.isSending { await Task.yield() }
    let writesBeforeSignOut = cache.writes
    active = false
    cache.value = nil
    let result = await task.value
    XCTAssertNil(result)
    XCTAssertNil(cache.value)
    XCTAssertEqual(cache.writes, writesBeforeSignOut)
  }

  func testCorruptFileIsNotSilentlyOverwritten() throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let cache = SavedFileCache(userID: UUID(), parent: parent)
    try cache.write(SavedSnapshot())
    try Data("not JSON".utf8).write(to: cache.file)
    XCTAssertThrowsError(try cache.read())
    XCTAssertEqual(try Data(contentsOf: cache.file), Data("not JSON".utf8))
  }
}
