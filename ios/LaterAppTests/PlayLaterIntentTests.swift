import AppIntents
import Auth
import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class PlayLaterIntentTests: XCTestCase {
  func testPlansAndPlays() throws {
    let ready = try [entry(1, duration: 480), entry(2, duration: 300)]
    var played: [LaterKit.LibraryItem] = []
    let model = ListenViewModel(
      read: { ListenSnapshot(ready: ready) },
      start: {
        played = $0; return true
      })
    let message = PlayLaterAction.perform(minutes: .ten, model: model)
    let expected = try TimeFitPlanner.plan(target: .ten, candidates: ready.map(\.candidate))
    XCTAssertEqual(played.map { $0.id.uuidString }, expected.items.map(\.id))
    XCTAssertTrue(message.hasPrefix("Playing 8 minutes"))
  }

  func testResumesInProgress() throws {
    let ready = try [entry(1, duration: 480), entry(2, duration: 1200, position: 100)]
    var played: [LaterKit.LibraryItem] = []
    let model = ListenViewModel(
      read: { ListenSnapshot(ready: ready) },
      start: {
        played = $0; return true
      })
    XCTAssertEqual(
      PlayLaterAction.perform(minutes: nil, model: model), "Resuming your listen in Later.")
    XCTAssertEqual(played.map(\.id), [ready[1].id])
  }

  func testNothingReady() {
    let model = ListenViewModel(
      read: { ListenSnapshot() },
      start: { _ in
        XCTFail("Must not play"); return true
      })
    XCTAssertEqual(
      PlayLaterAction.perform(minutes: nil, model: model),
      "Nothing's ready to listen to yet in Later.")
  }

  func testDefaultsToFifteenAndReportsUnderfill() throws {
    let ready = try [entry(1, duration: 720)]
    let model = ListenViewModel(read: { ListenSnapshot(ready: ready) }, start: { _ in true })
    XCTAssertEqual(
      PlayLaterAction.perform(minutes: nil, model: model),
      "Playing 12 minutes from Later. That's everything ready right now.")
    XCTAssertEqual(model.slot, .fifteen)
  }

  func testDoesNotClaimSuccessWhenAudioFailsOrDoesNotFit() throws {
    let ready = try [entry(1, duration: 720)]
    let model = ListenViewModel(read: { ListenSnapshot(ready: ready) }, start: { _ in false })
    XCTAssertTrue(
      PlayLaterAction.perform(minutes: .fifteen, model: model).contains("Couldn't start"))
    XCTAssertTrue(
      PlayLaterAction.perform(minutes: .ten, model: model).contains("Nothing ready fits"))
    let broken = ListenViewModel(
      read: { throw CocoaError(.fileReadNoPermission) },
      start: { _ in
        XCTFail(); return true
      })
    XCTAssertTrue(PlayLaterAction.perform(minutes: nil, model: broken).contains("Couldn't read"))
  }

  func testRunsLockedWithoutNetwork() async throws {
    func requireAudio<T: AudioPlaybackIntent>(_: T.Type) {}
    requireAudio(PlayLaterIntent.self)
    XCTAssertFalse(PlayLaterIntent.openAppWhenRun)
    XCTAssertEqual(PlayLaterIntent.authenticationPolicy, .alwaysAllowed)
    URLProtocol.registerClass(RejectSiriNetwork.self)
    defer { URLProtocol.unregisterClass(RejectSiriNetwork.self) }
    let storage = SiriSessionStorage(data: try JSONEncoder().encode(AuthTestSupport.session))
    let config = try AppAuthConfiguration(info: [
      "SUPABASE_URL": "https://example.supabase.co",
      "SUPABASE_ANON_KEY": "sb_publishable_test_fixture",
      "LATER_API_BASE_URL": "https://example.org",
    ])
    let backend = SupabaseAuthBackend(
      configuration: config, storage: storage,
      fetch: { _ in
        XCTFail("Local restoration must never call auth HTTP")
        throw URLError(.notConnectedToInternet)
      })
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let cache = SavedFileCache(userID: AuthTestSupport.session.user.id, parent: parent)
    let item = try entry(1, duration: 480).item
    try cache.write(SavedSnapshot(items: [item], hasLoaded: true))
    let auth = AuthService(
      backend: backend, storage: storage, caches: UserCacheCleaner(directories: []))
    let coordinator = NarrationCoordinator(
      auth: auth,
      makeModel: { _ in
        SavedViewModel(client: RejectSiriAPI(), cache: cache)
      })
    let restored = await coordinator.prepareLocal()
    XCTAssertTrue(restored)
    XCTAssertEqual(coordinator.model?.items.map(\.id), [item.id])
    let response = PlayLaterAction.perform(minutes: .ten, model: .live(coordinator))
    XCTAssertEqual(response, "Nothing's ready to listen to yet in Later.")
    coordinator.resetSession()
  }

  private func entry(_ n: Int, duration: Double, position: Double = 0) throws -> ReadyListen {
    let data = Data(
      """
      {"captureId":"00000000-0000-4000-8000-00000000000\(n)","title":"Item","source":"Example","savedAt":"2026-11-12T12:00:00Z","kind":"article","listen":{"state":"narratable","textVersion":"v1","wordCount":50}}
      """.utf8)
    return ReadyListen(
      item: try JSONDecoder().decode(LaterKit.LibraryItem.self, from: data), duration: duration,
      position: position)
  }
}

private struct SiriSessionStorage: SessionStorageClearing {
  let data: Data
  func retrieve(key: String) -> Data? { key == "later.auth.session" ? data : nil }
  func store(key: String, value: Data) {}
  func remove(key: String) {}
  func clearAll() {}
}

private struct RejectSiriAPI: LaterAPIClient {
  func send(_ request: LaterAPIRequest) async throws -> Data {
    XCTFail("Siri must never fetch the library or send pending actions")
    throw URLError(.notConnectedToInternet)
  }
}

private final class RejectSiriNetwork: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    XCTFail("Siri must not make network requests")
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
  override func stopLoading() {}
}
