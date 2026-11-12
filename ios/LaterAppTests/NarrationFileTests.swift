import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class NarrationFileTests: XCTestCase {
  func testProtectionBackupExclusionAndSignOut() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let auth = AuthService(
      backend: AuthTestSupport.Backend(signedIn: true, failRequests: false),
      storage: AuthTestSupport.Storage(),
      caches: UserCacheCleaner(directories: [
        parent.appendingPathComponent(UserCacheCleaner.directoryName)
      ]))
    await auth.restore()
    var options: [Data.WritingOptions] = []
    let files = NarrationFiles(userID: try XCTUnwrap(auth.session?.user.id), parent: parent) {
      data, url, flags in
      options.append(flags)
      try data.write(to: url, options: flags)
    }
    let store = try NarrationStore(
      client: NarrationAPIStub(), renderer: FixtureNarrationRenderer(), files: files)
    let item = try NarrationFixtures.item()
    store.enqueue(item)
    await store.process()
    let manifest = try XCTUnwrap(store.manifest(for: item))
    let audio = files.audioURL(manifest)
    XCTAssertFalse(options.isEmpty)
    XCTAssertTrue(
      options.allSatisfy {
        $0.contains(.atomic) && $0.contains(.completeFileProtectionUntilFirstUserAuthentication)
      })
    for url in [files.root, audio] {
      XCTAssertEqual(
        try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
      #if !targetEnvironment(simulator)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual(
          attrs[.protectionKey] as? String,
          FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
      #endif
    }
    await auth.signOut()
    XCTAssertFalse(FileManager.default.fileExists(atPath: files.root.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: audio.path))
    XCTAssertTrue(try files.load().manifests.isEmpty)
  }

  func testMissingAudioAndInterruptedRenderAreNotReady() throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let files = NarrationFiles(userID: UUID(), parent: parent)
    let orphan = UUID()
    _ = try files.createWorkDirectory(orphan)
    try files.save(NarrationSnapshot())
    _ = try NarrationStore(
      client: NarrationAPIStub(), renderer: FixtureNarrationRenderer(), files: files)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: files.root.appendingPathComponent(orphan.uuidString).path))
    XCTAssertTrue(try files.load().manifests.isEmpty)
  }
}

extension NarrationFileTests {
  func testBuiltAppRegistersProcessingWithoutLosingSignInConfiguration() {
    let info = Bundle.main.infoDictionary ?? [:]
    XCTAssertEqual(
      info["BGTaskSchedulerPermittedIdentifiers"] as? [String],
      [NarrationCoordinator.backgroundIdentifier])
    XCTAssertTrue((info["UIBackgroundModes"] as? [String] ?? []).contains("processing"))
    XCTAssertNotNil(info["SUPABASE_URL"])
    XCTAssertNotNil(info["CFBundleURLTypes"])
  }
}

extension NarrationFileTests {
  func testCorruptNarrationManifestDoesNotBlockSavedOrDeleteItsActionQueue() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let files = NarrationFiles(userID: UUID(), parent: parent)
    try files.save(NarrationSnapshot())
    try Data("corrupt JSON".utf8).write(to: files.root.appendingPathComponent("manifest.json"))
    let item = try SavedFixtures.item()
    let action = PendingItemAction(captureId: item.id, action: .consume)
    let cache = SavedMemoryCache()
    cache.value = SavedSnapshot(items: [item], nextCursor: nil, hasLoaded: true, pending: [action])
    let client = SavedAPIStub()
    await client.setPages(first: try SavedFixtures.page([item]))
    let model = SavedServiceFactory.makeModel(
      client: client, cache: cache, narrationClient: NarrationAPIStub(),
      renderer: FixtureNarrationRenderer(), files: files)
    XCTAssertEqual(
      cache.value?.pending, [action], "Only narration's rebuildable cache may be removed")
    XCTAssertNotNil(model.narration)
    await model.start()
    XCTAssertTrue(model.snapshot.hasLoaded)
    XCTAssertEqual(model.items, [item])
    XCTAssertFalse(model.showEmpty)
  }

  func testManifestNewFieldsDefaultWhenReadingOlderSchema() throws {
    struct Legacy: Encodable {
      let manifests: [UUID: NarrationManifest] = [:]
      let pending: [NarrationCandidate] = []
    }
    let snapshot = try JSONDecoder().decode(
      NarrationSnapshot.self, from: JSONEncoder().encode(Legacy()))
    XCTAssertTrue(snapshot.explicit.isEmpty)
    XCTAssertTrue(snapshot.conflicts.isEmpty)
    XCTAssertTrue(snapshot.failures.isEmpty)
  }
}
