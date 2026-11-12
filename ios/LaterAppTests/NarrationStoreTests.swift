import AVFoundation
import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class NarrationStoreTests: XCTestCase {
  private var parent: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  func testDurationIsMeasured() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let voices = AVSpeechSynthesisVoice.speechVoices()
    guard !voices.isEmpty else {
      throw XCTSkip("Hosted simulator has zero installed speech voices")
    }
    let client = NarrationAPIStub()
    let item = try NarrationFixtures.item()
    let store = try make(client, renderer: DeviceNarrationRenderer(), parent: directory)
    store.enqueue(item)
    let work = Task { await store.process() }
    let timeout = Task {
      do { try await Task.sleep(for: .seconds(45)); work.cancel() } catch {}
    }
    await work.value
    timeout.cancel()
    let manifest = try XCTUnwrap(
      store.manifest(for: item), store.message ?? "Speech did not finish")
    let measured = try await AVURLAsset(url: store.files.audioURL(manifest)).load(.duration).seconds
    XCTAssertEqual(manifest.duration, measured, accuracy: 0.001)
    XCTAssertGreaterThan(manifest.duration, 0)
    XCTAssertFalse(manifest.voiceID.isEmpty)
  }

  func testOnlyEndpointCanProduceAudioAndReadyMeansComplete() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let client = NarrationAPIStub()
    let renderer = FixtureNarrationRenderer()
    let store = try make(client, renderer: renderer, parent: directory)
    let item = try NarrationFixtures.item()
    await store.process()
    XCTAssertTrue(renderer.texts.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.files.root.path))
    store.enqueue(item)
    XCTAssertNil(store.manifest(for: item))
    XCTAssertEqual(store.statusLabel(for: item), "Preparing audio…")
    await store.process()
    let requests = await client.requests
    XCTAssertEqual(requests.map(\.path), ["api/app/narrations/\(item.id.uuidString)"])
    XCTAssertEqual(renderer.texts.count, 1)
    let manifest = try XCTUnwrap(store.manifest(for: item))
    XCTAssertEqual(manifest.duration, 2, accuracy: 0.001)
    XCTAssertEqual(store.statusLabel(for: item), "Ready to listen · 1 min")
    XCTAssertTrue(store.snapshot.pending.isEmpty)
    store.enqueue(item)
    await store.process()
    XCTAssertEqual(renderer.texts.count, 1)
    let offline = try make(
      client, renderer: renderer, parent: directory, userID: NarrationFixtures.user)
    XCTAssertEqual(offline.manifest(for: item), manifest)
  }

  func testOpenOriginalOnConflict() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let client = NarrationAPIStub()
    await client.fail(NarrationError.openOriginal(.paywalled))
    let renderer = FixtureNarrationRenderer()
    let store = try make(client, renderer: renderer, parent: directory)
    let item = try NarrationFixtures.item()
    store.enqueue(item)
    await store.process()
    XCTAssertTrue(renderer.texts.isEmpty)
    XCTAssertNil(store.manifest(for: item))
    XCTAssertEqual(store.statusLabel(for: item), "Open original")
    XCTAssertEqual(store.reasonLabel(for: item), "Behind a paywall")
    XCTAssertTrue(store.snapshot.pending.isEmpty)
    let restored = try make(client, renderer: renderer, parent: directory)
    XCTAssertEqual(restored.reasonLabel(for: item), "Behind a paywall")
  }

  func testReRendersOnNewVersion() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let client = NarrationAPIStub()
    let renderer = FixtureNarrationRenderer()
    let store = try make(client, renderer: renderer, parent: directory)
    let old = try NarrationFixtures.item()
    store.enqueue(old)
    await store.process()
    let oldFile = store.files.audioURL(try XCTUnwrap(store.manifest(for: old)))
    let new = try NarrationFixtures.item(id: old.id, version: "v2")
    await client.setVersion("v2")
    store.enqueue(new)
    XCTAssertNil(store.manifest(for: new))
    await store.process()
    XCTAssertEqual(store.manifest(for: new)?.textVersion, "v2")
    XCTAssertEqual(renderer.texts.map(\.textVersion), ["v1", "v2"])
    XCTAssertFalse(FileManager.default.fileExists(atPath: oldFile.path))
  }

  func testEviction() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let client = NarrationAPIStub()
    let renderer = FixtureNarrationRenderer()
    let files = NarrationFiles(userID: NarrationFixtures.user, parent: directory)
    let seed = try NarrationStore(client: client, renderer: renderer, files: files)
    let items = try (0..<4).map { _ in try NarrationFixtures.item() }
    for item in items.prefix(3) { seed.enqueue(item); await seed.process() }
    seed.markHeard(items[0].id, at: Date(timeIntervalSince1970: 1))
    seed.markHeard(items[1].id, at: Date(timeIntervalSince1970: 2))
    let one = try files.bytes(XCTUnwrap(seed.manifest(for: items[0])))
    let store = try NarrationStore(client: client, renderer: renderer, files: files, cap: one * 3)
    store.playingID = items[0].id
    store.enqueue(items[3])
    await store.process()
    XCTAssertNotNil(
      store.manifest(for: items[0]), "Playing file must survive despite being oldest heard")
    XCTAssertNil(
      store.manifest(for: items[1]), "Next oldest heard should be evicted before unheard")
    XCTAssertNotNil(store.manifest(for: items[2]))
    XCTAssertNotNil(store.manifest(for: items[3]))
    let total = try store.snapshot.manifests.values.reduce(Int64(0)) { try $0 + files.bytes($1) }
    XCTAssertLessThanOrEqual(total, one * 3)
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: files.audioURL(try XCTUnwrap(seed.manifest(for: items[1]))).path))
  }

  func testAutomaticQueueIsBoundedAndExplicitItemSurvivesRefresh() throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try make(
      NarrationAPIStub(), renderer: FixtureNarrationRenderer(), parent: directory)
    let items = try (1...20).map {
      try NarrationFixtures.item(date: String(format: "2026-11-%02dT12:00:00Z", $0))
    }
    store.enqueueNewest(items)
    XCTAssertEqual(store.snapshot.pending.map(\.id), items.suffix(10).reversed().map(\.id))
    store.enqueue(items[0])
    store.enqueueNewest(Array(items.prefix(10)))
    XCTAssertEqual(store.snapshot.pending.count, 10)
    store.enqueueNewest(Array(items.suffix(10)))
    XCTAssertEqual(store.snapshot.pending.count, 11)
    XCTAssertTrue(store.snapshot.pending.contains { $0.id == items[0].id })
  }

  func testFailureAndCancellationNeverPublishPartialAudio() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    let client = NarrationAPIStub()
    let renderer = FixtureNarrationRenderer()
    renderer.fail = true
    let store = try make(client, renderer: renderer, parent: directory)
    let item = try NarrationFixtures.item()
    store.enqueue(item)
    await store.process()
    XCTAssertNil(store.manifest(for: item))
    XCTAssertEqual(store.snapshot.pending.count, 1)
    XCTAssertNotNil(store.message)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: store.files.root.path), ["manifest.json"])
    renderer.fail = false
    await store.process()
    XCTAssertNotNil(store.manifest(for: item))
  }

  func testLateDownloadCannotCreateFilesAfterSignOut() async throws {
    let directory = parent
    defer { try? FileManager.default.removeItem(at: directory) }
    var active = true
    let client = NarrationAPIStub()
    await client.setDelay()
    let renderer = FixtureNarrationRenderer()
    let store = try NarrationStore(
      client: client, renderer: renderer,
      files: NarrationFiles(userID: NarrationFixtures.user, parent: directory),
      isActive: { active })
    let item = try NarrationFixtures.item()
    store.enqueue(item)
    let work = Task { await store.process() }
    while store.preparing == nil { await Task.yield() }
    active = false
    try UserCacheCleaner(directories: [
      directory.appendingPathComponent(UserCacheCleaner.directoryName)
    ]).clearAll()
    await work.value
    XCTAssertTrue(renderer.texts.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.files.root.path))
  }

  private func make(
    _ client: NarrationAPIStub, renderer: any NarrationRendering, parent: URL,
    userID: UUID = NarrationFixtures.user
  ) throws -> NarrationStore {
    try NarrationStore(
      client: client, renderer: renderer, files: NarrationFiles(userID: userID, parent: parent))
  }
}

@MainActor
final class FixtureNarrationRenderer: NarrationRendering {
  var texts: [NarrationText] = []
  var fail = false
  func render(_ text: NarrationText, in directory: URL) throws -> RenderedNarration {
    texts.append(text)
    let file = directory.appendingPathComponent("audio.caf")
    let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1))
    let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000))
    buffer.frameLength = buffer.frameCapacity
    if let samples = buffer.floatChannelData {
      samples[0].initialize(repeating: 0, count: Int(buffer.frameLength))
    }
    try AVAudioFile(forWriting: file, settings: format.settings).write(from: buffer)
    if fail { throw CocoaError(.fileWriteOutOfSpace) }
    return RenderedNarration(file: file, voiceID: "fixture.voice")
  }
  func cancel() {}
}

actor NarrationAPIStub: LaterAPIClient {
  var requests: [LaterAPIRequest] = []
  var failure: (any Error)?
  var version = "v1"
  var delay = false
  func fail(_ error: any Error) { failure = error }
  func setVersion(_ value: String) { version = value }
  func setDelay() { delay = true }
  func send(_ request: LaterAPIRequest) async throws -> Data {
    requests.append(request)
    if delay { try await Task.sleep(for: .milliseconds(100)) }
    if let failure { throw failure }
    return try JSONSerialization.data(withJSONObject: [
      "captureId": request.path.split(separator: "/").last.map(String.init) ?? "",
      "textVersion": version,
      "title": "A morning", "sourceUrl": "https://example.org", "siteName": "Example",
      "intro": "A morning. From Example. Narrated by Later.", "paragraphs": ["Hello, morning."],
      "outro": "End of A morning, from Example.", "wordCount": 2,
    ])
  }
}

enum NarrationFixtures {
  static let user = UUID()
  static func item(
    id: UUID = UUID(), version: String = "v1", date: String = "2026-11-12T12:00:00Z"
  ) throws -> LaterKit.LibraryItem {
    let data = try JSONSerialization.data(withJSONObject: [
      "captureId": id.uuidString, "title": "A morning", "source": "Example", "savedAt": date,
      "kind": "article",
      "listen": ["state": "narratable", "textVersion": version, "wordCount": 2],
    ])
    return try JSONDecoder().decode(LaterKit.LibraryItem.self, from: data)
  }
}
