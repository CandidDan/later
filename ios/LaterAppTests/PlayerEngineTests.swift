import AVFoundation
import Foundation
import LaterKit
import MediaPlayer
import XCTest

@testable import Later

@MainActor
final class PlayerEngineTests: XCTestCase {
  func testAudioSessionAndBackgroundMode() throws {
    let session = SpokenAudioSession()
    try session.activate()
    defer { session.deactivate() }
    XCTAssertEqual(AVAudioSession.sharedInstance().category, .playback)
    XCTAssertEqual(AVAudioSession.sharedInstance().mode, .spokenAudio)
    XCTAssertTrue(
      (Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String] ?? []).contains("audio"))
    XCTAssertTrue(
      (Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String] ?? []).contains("processing"))
  }

  func testRemoteCommands() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let controls = PlayerRemoteControls()
    let engine = fixture.engine(remote: controls)
    defer { engine.shutdown() }
    try engine.start(fixture.items, autoplay: false)
    controls.dispatch(.play)
    XCTAssertTrue(engine.isPlaying)
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "First"
    )
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtist] as? String,
      "Example")
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyAlbumTitle] as? String,
      "Later")
    controls.dispatch(.pause)
    XCTAssertFalse(engine.isPlaying)
    controls.dispatch(.toggle)
    XCTAssertTrue(engine.isPlaying)
    controls.dispatch(.forward)
    XCTAssertEqual(engine.position, 30)
    controls.dispatch(.back)
    XCTAssertEqual(engine.position, 15)
    controls.dispatch(.seek(42))
    XCTAssertEqual(engine.position, 42)
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime]
        as? Double, 42)
    engine.setSpeed(1.5)
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate]
        as? Double, 1.5)
    controls.dispatch(.next)
    XCTAssertEqual(engine.current?.title, "Second")
    controls.dispatch(.previous)
    XCTAssertEqual(engine.current?.title, "First")
    XCTAssertEqual(engine.position, 0)
    controls.dispatch(.pause)
    XCTAssertEqual(
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate]
        as? Double, 0)
  }

  func testInterruptionAndRouteNotifications() async throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let center = NotificationCenter()
    let engine = fixture.engine(notifications: center)
    defer { engine.shutdown() }
    try engine.start(fixture.items)
    fixture.driver.position = 25
    center.post(
      name: AVAudioSession.interruptionNotification, object: nil,
      userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertFalse(engine.isPlaying)
    XCTAssertEqual(fixture.persistence.value.positions[fixture.items[0].id]?.seconds, 25)
    center.post(
      name: AVAudioSession.interruptionNotification, object: nil,
      userInfo: [
        AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
        AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume
          .rawValue,
      ])
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertTrue(engine.isPlaying)
    center.post(
      name: AVAudioSession.interruptionNotification, object: nil,
      userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])
    try await Task.sleep(for: .milliseconds(20))
    center.post(
      name: AVAudioSession.interruptionNotification, object: nil,
      userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertFalse(engine.isPlaying)
    engine.play()
    center.post(
      name: AVAudioSession.routeChangeNotification, object: nil,
      userInfo: [
        AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable
          .rawValue
      ])
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertFalse(engine.isPlaying)
    center.post(
      name: AVAudioSession.interruptionNotification, object: nil,
      userInfo: [
        AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
        AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume
          .rawValue,
      ])
    try await Task.sleep(for: .milliseconds(20))
    XCTAssertFalse(engine.isPlaying, "Unplugging cancels automatic resumption")
  }

  func testFinishingDoesNotConsume() async throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let client = SavedAPIStub()
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    await model.start()
    let engine = fixture.engine()
    defer { engine.shutdown() }
    try engine.start(fixture.items)
    fixture.driver.onFinish?()
    XCTAssertEqual(engine.current?.id, fixture.items[1].id)
    XCTAssertEqual(fixture.persistence.value.startPosition(for: fixture.items[0]), 0)
    fixture.driver.onFinish?()
    XCTAssertFalse(engine.isPlaying)
    XCTAssertTrue(engine.queue?.isFinished == true)
    let requests = await client.requests
    XCTAssertFalse(requests.contains { $0.method == .post })
  }

  func testPlaysWithoutNetwork() async throws {
    let fixture = try PlayerFixture(realAudio: true)
    defer { fixture.cleanup() }
    RejectPlaybackNetwork.requests.reset()
    URLProtocol.registerClass(RejectPlaybackNetwork.self)
    defer { URLProtocol.unregisterClass(RejectPlaybackNetwork.self) }
    let driver = LocalAudioDriver()
    let engine = PlayerEngine(
      driver: driver, audioSession: SpokenAudioSession(), remote: PlayerRemoteStub(),
      persistence: fixture.persistence, automaticTicks: false, resolve: { _ in fixture.url })
    defer { engine.shutdown() }
    try engine.start([fixture.items[0]])
    try await Task.sleep(for: .seconds(1))
    engine.tick()
    XCTAssertTrue(engine.isPlaying)
    XCTAssertGreaterThan(engine.position, 0)
    XCTAssertEqual(RejectPlaybackNetwork.requests.count, 0)
  }

  func testPersistsEveryFiveSecondsPauseBackgroundAndRestoresEarlier() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let engine = fixture.engine()
    try engine.start(fixture.items)
    fixture.driver.position = 20
    let now = Date()
    engine.tick(now: now)
    let writes = fixture.persistence.writes
    fixture.driver.position = 23
    engine.tick(now: now.addingTimeInterval(4))
    XCTAssertEqual(fixture.persistence.writes, writes)
    fixture.driver.position = 25
    engine.tick(now: now.addingTimeInterval(5))
    XCTAssertEqual(fixture.persistence.writes, writes + 1)
    fixture.driver.position = 30
    engine.backgrounded()
    XCTAssertTrue(engine.isPlaying, "Backgrounding persists without stopping local audio")
    XCTAssertEqual(fixture.persistence.value.positions[fixture.items[0].id]?.seconds, 30)
    fixture.driver.position = 40
    engine.pause()
    XCTAssertEqual(fixture.persistence.value.positions[fixture.items[0].id]?.seconds, 40)
    engine.shutdown()
    let restored = fixture.engine()
    defer { restored.shutdown() }
    try restored.start(fixture.items, autoplay: false)
    XCTAssertEqual(restored.position, 35)
    XCTAssertEqual(restored.speed, 1)
  }

  func testRestartUsesLatestPositionAndDecoderFailureStops() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let engine = fixture.engine()
    defer { engine.shutdown() }
    try engine.start(fixture.items)
    fixture.driver.position = 50
    try engine.start(fixture.items)
    XCTAssertEqual(engine.position, 45)
    fixture.driver.position = 60
    fixture.driver.onFailure?()
    XCTAssertFalse(engine.isPlaying)
    XCTAssertNotNil(engine.message)
    XCTAssertEqual(fixture.persistence.value.positions[fixture.items[0].id]?.seconds, 60)
  }

  func testResumeFileRoundTripAndCorruptionRecovery() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let file = ResumeFile(url: fixture.directory.appendingPathComponent("resume/progress.json"))
    XCTAssertEqual(try file.read(), ResumeStore())
    var value = ResumeStore()
    value.record(fixture.items[0], position: 50)
    try file.write(value)
    XCTAssertEqual(try file.read(), value)
    XCTAssertEqual(
      try file.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    try Data("bad json".utf8).write(to: file.url)
    let engine = PlayerEngine(
      driver: fixture.driver, audioSession: PlayerSessionStub(), remote: PlayerRemoteStub(),
      persistence: file, automaticTicks: false, resolve: { _ in fixture.url })
    defer { engine.shutdown() }
    try engine.start(fixture.items, autoplay: false)
    XCTAssertEqual(engine.position, 0)
  }

  func testSignOutStopsAndCannotRecreateProgress() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    var active = true
    var protectedID: UUID?
    let controls = PlayerRemoteStub()
    let engine = PlayerEngine(
      driver: fixture.driver, audioSession: PlayerSessionStub(), remote: controls,
      persistence: fixture.persistence, automaticTicks: false, resolve: { _ in fixture.url },
      protectPlaying: { protectedID = $0 }, isActive: { active })
    defer { engine.shutdown() }
    try engine.start(fixture.items)
    XCTAssertEqual(protectedID, fixture.items[0].id)
    active = false
    let writes = fixture.persistence.writes
    controls.onCommand?(.play)
    engine.tick()
    engine.backgrounded()
    XCTAssertFalse(engine.isPlaying)
    XCTAssertNil(engine.current)
    XCTAssertNil(protectedID)
    XCTAssertNil(controls.value)
    XCTAssertEqual(fixture.persistence.writes, writes)
  }

  func testRejectsRemoteFilesAndInvalidSpeed() throws {
    let fixture = try PlayerFixture()
    defer { fixture.cleanup() }
    let remoteURL = try XCTUnwrap(URL(string: "https://example.org/audio.m4a"))
    let engine = PlayerEngine(
      driver: fixture.driver, audioSession: PlayerSessionStub(), remote: PlayerRemoteStub(),
      persistence: fixture.persistence, automaticTicks: false, resolve: { _ in remoteURL })
    defer { engine.shutdown() }
    XCTAssertThrowsError(try engine.start(fixture.items))
    XCTAssertFalse(engine.isPlaying)
    engine.setSpeed(.nan)
    engine.setSpeed(3)
    XCTAssertEqual(engine.speed, 1)
    XCTAssertThrowsError(try LocalAudioDriver().load(remoteURL))
  }
}

@MainActor
final class PlayerDriverStub: PlayerAudioDriving {
  var position: TimeInterval = 0
  var onFailure: (() -> Void)?
  var onFinish: (() -> Void)?
  var rate: Float = 1
  func load(_ url: URL) { position = 0 }
  func play(rate: Float) { self.rate = rate }
  func pause() {}
  func stop() { position = 0 }
}

struct PlayerSessionStub: PlayerSessionConfiguring {
  func activate() {}
  func deactivate() {}
}

@MainActor
final class PlayerResumeStub: ResumePersisting {
  var value = ResumeStore()
  var writes = 0
  func read() -> ResumeStore { value }
  func write(_ value: ResumeStore) { self.value = value; writes += 1 }
}

@MainActor
final class PlayerRemoteStub: PlayerRemoteControlling {
  var onCommand: ((PlayerCommand) -> Void)?
  var value: PlayerNowPlaying?
  func update(_ value: PlayerNowPlaying?) { self.value = value }
  func clear() { value = nil; onCommand = nil }
}

@MainActor
final class PlayerFixture {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let driver = PlayerDriverStub()
  let persistence = PlayerResumeStub()
  let items: [PlaybackItem]
  var url: URL { directory.appendingPathComponent("audio.caf") }
  init(realAudio: Bool = false) throws {
    items = ["First", "Second"].map {
      PlaybackItem(
        captureId: UUID(), textVersion: "v1", title: $0, source: "Example", duration: 120)
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if realAudio {
      let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1))
      let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2_880_000))
      buffer.frameLength = buffer.frameCapacity
      if let data = buffer.floatChannelData {
        data[0].initialize(repeating: 0, count: Int(buffer.frameLength))
      }
      try AVAudioFile(forWriting: url, settings: format.settings).write(from: buffer)
    } else {
      try Data([0]).write(to: url)
    }
  }
  func cleanup() { try? FileManager.default.removeItem(at: directory) }
  func engine(
    remote: any PlayerRemoteControlling = PlayerRemoteStub(),
    notifications: NotificationCenter = NotificationCenter()
  ) -> PlayerEngine {
    PlayerEngine(
      driver: driver, audioSession: PlayerSessionStub(), remote: remote,
      persistence: persistence, notifications: notifications, automaticTicks: false,
      resolve: { [url] _ in url })
  }
}

private final class NetworkRequestCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func reset() { lock.withLock { value = 0 } }
  func increment() { lock.withLock { value += 1 } }
}

private final class RejectPlaybackNetwork: URLProtocol, @unchecked Sendable {
  static let requests = NetworkRequestCounter()
  override class func canInit(with request: URLRequest) -> Bool {
    ["https", "http"].contains(request.url?.scheme ?? "")
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.increment()
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
  override func stopLoading() {}
}
