import AVFoundation
import Foundation
import LaterKit

@MainActor
protocol PlayerAudioDriving: AnyObject {
  var position: TimeInterval { get set }
  var onFailure: (() -> Void)? { get set }
  var onFinish: (() -> Void)? { get set }
  func load(_ url: URL) throws
  func play(rate: Float) throws
  func pause()
  func stop()
}

@MainActor
final class LocalAudioDriver: NSObject, PlayerAudioDriving, AVAudioPlayerDelegate {
  enum Failure: Error { case notLocal, unavailable }
  private var player: AVAudioPlayer?
  var onFinish: (() -> Void)?
  var onFailure: (() -> Void)?
  var position: TimeInterval {
    get { player?.currentTime ?? 0 }
    set { player?.currentTime = newValue }
  }

  func load(_ url: URL) throws {
    guard url.isFileURL else { throw Failure.notLocal }
    stop()
    let audio = try AVAudioPlayer(contentsOf: url)
    audio.enableRate = true
    audio.delegate = self
    guard audio.prepareToPlay() else { throw Failure.unavailable }
    player = audio
  }
  func play(rate: Float) throws {
    guard let player else { throw Failure.unavailable }
    player.rate = rate
    guard player.play() else { throw Failure.unavailable }
  }
  func pause() { player?.pause() }
  func stop() { player?.delegate = nil; player?.stop(); player = nil }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    let identifier = ObjectIdentifier(player)
    Task { @MainActor [weak self] in
      guard let self, let current = self.player, ObjectIdentifier(current) == identifier else {
        return
      }
      if flag { self.onFinish?() } else { self.onFailure?() }
    }
  }
  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    let identifier = ObjectIdentifier(player)
    Task { @MainActor [weak self] in
      guard let self, let current = self.player, ObjectIdentifier(current) == identifier else {
        return
      }
      self.onFailure?()
    }
  }
}

@MainActor
protocol PlayerSessionConfiguring {
  func activate() throws
  func deactivate()
}

struct SpokenAudioSession: PlayerSessionConfiguring {
  func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
  }
  func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

@MainActor
protocol ResumePersisting {
  func read() throws -> ResumeStore
  func write(_ value: ResumeStore) throws
}

struct ResumeFile: ResumePersisting {
  let url: URL
  func read() throws -> ResumeStore {
    guard FileManager.default.fileExists(atPath: url.path) else { return ResumeStore() }
    return try JSONDecoder().decode(ResumeStore.self, from: Data(contentsOf: url))
  }
  func write(_ value: ResumeStore) throws {
    let parent = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: parent, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try JSONEncoder().encode(value).write(
      to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}
