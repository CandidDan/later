import AVFoundation
import Foundation
import LaterKit
import Observation
import UIKit

@MainActor
@Observable
final class PlayerEngine {
  static let speeds: [Double] = [0.8, 1, 1.25, 1.5, 1.75, 2]
  private(set) var queue: PlaybackQueue?
  private(set) var isPlaying = false
  private(set) var speed: Double = 1
  private(set) var message: String?
  var current: PlaybackItem? { queue?.current }
  var position: TimeInterval { queue?.position ?? 0 }
  var remaining: TimeInterval { queue?.remaining(at: speed) ?? 0 }
  private let driver: any PlayerAudioDriving
  private let audioSession: any PlayerSessionConfiguring
  private let remote: any PlayerRemoteControlling
  private let persistence: any ResumePersisting
  private var resume: ResumeStore
  private let resolve: (PlaybackItem) throws -> URL
  private let protectPlaying: (UUID?) -> Void
  private let markHeard: (UUID) -> Void
  private let isActive: () -> Bool
  private let notifications: NotificationCenter
  private var observers: [NSObjectProtocol] = []
  private var ticker: Task<Void, Never>?
  private var lastPersist = Date.distantPast
  private var resumeAfterInterruption = false
  private var closed = false
  private var audioLoaded = false

  init(
    driver: any PlayerAudioDriving = LocalAudioDriver(),
    audioSession: any PlayerSessionConfiguring = SpokenAudioSession(),
    remote: any PlayerRemoteControlling = PlayerRemoteControls(), persistence: any ResumePersisting,
    notifications: NotificationCenter = .default, automaticTicks: Bool = true,
    resolve: @escaping (PlaybackItem) throws -> URL,
    protectPlaying: @escaping (UUID?) -> Void = { _ in },
    markHeard: @escaping (UUID) -> Void = { _ in },
    isActive: @escaping () -> Bool = { true }
  ) {
    self.driver = driver
    self.audioSession = audioSession
    self.remote = remote
    self.persistence = persistence
    self.notifications = notifications
    self.resolve = resolve
    self.protectPlaying = protectPlaying
    self.markHeard = markHeard
    self.isActive = isActive
    resume = (try? persistence.read()) ?? ResumeStore()
    driver.onFailure = { [weak self] in
      self?.updatePosition(); self?.persist(); self?.failed()
    }
    driver.onFinish = { [weak self] in self?.finished() }
    remote.onCommand = { [weak self] in self?.handle($0) }
    observeSystemEvents()
    if automaticTicks {
      ticker = Task { [weak self] in
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(1)) } catch { return }
          guard let self else { return }
          self.tick()
        }
      }
    }
  }

  /// Ordered queue API for Saved, Listen and Siri. Selection belongs to those callers.
  func start(_ items: [PlaybackItem], autoplay: Bool = true) throws {
    guard validSession() else { return }
    do {
      _ = try PlaybackQueue(items: items)
      for item in items {
        let url = try resolve(item)
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path) else {
          throw LocalAudioDriver.Failure.notLocal
        }
      }
    } catch {
      message = "This audio isn't available. Prepare it again in Saved."
      throw error
    }
    // Save the old queue before deriving resume positions, including a restart of its current item.
    pause()
    let prepared = items.map { item in
      var item = item
      item.startPosition = resume.startPosition(for: item)
      return item
    }
    let next = try PlaybackQueue(items: prepared)
    audioLoaded = false
    driver.stop()
    protectPlaying(nil)
    queue = next
    message = nil
    do { try loadCurrent(autoplay: autoplay) } catch { failed(); throw error }
  }

  func handle(_ command: PlayerCommand) {
    guard validSession(), current != nil else { return }
    switch command {
    case .play: play()
    case .pause: pause()
    case .toggle: isPlaying ? pause() : play()
    case .forward: seek(position + 30)
    case .back: seek(position - 15)
    case .seek(let seconds): seek(seconds)
    case .next: next()
    case .previous: previous()
    }
  }

  func play() {
    guard validSession(), current != nil else { return }
    // An explicit Play retries activation even if iOS omitted interruption-ended.
    // Automatic resumption only reaches here from an ended notification with shouldResume.
    resumeAfterInterruption = false
    do {
      if queue?.isFinished == true || position >= (current?.duration ?? 0) {
        queue?.seek(to: 0)
        try loadCurrent(autoplay: true)
      } else if !audioLoaded {
        try loadCurrent(autoplay: true)
      } else {
        try audioSession.activate()
        try driver.play(rate: Float(speed))
        isPlaying = true
      }
      publish()
    } catch { failed() }
  }

  func pause() {
    resumeAfterInterruption = false
    guard validSession() else { return }
    updatePosition()
    driver.pause()
    isPlaying = false
    persist()
    publish()
  }

  func seek(_ seconds: TimeInterval) {
    guard validSession(), seconds.isFinite, current != nil else { return }
    queue?.seek(to: seconds)
    driver.position = position
    persist()
    publish()
    if isPlaying && position >= (current?.duration ?? 0) { finished() }
  }

  func setSpeed(_ value: Double) {
    guard validSession(), Self.speeds.contains(value) else { return }
    updatePosition()
    speed = value
    if isPlaying {
      do { try driver.play(rate: Float(speed)) } catch { failed() }
    }
    persist()
    publish()
  }

  func next() {
    guard validSession(), current != nil else { return }
    updatePosition()
    persist()
    let autoplay = isPlaying
    if queue?.advance() == true {
      do { try loadCurrent(autoplay: autoplay) } catch { failed() }
    } else {
      audioLoaded = false
      driver.stop()
      protectPlaying(nil)
      isPlaying = false
      publish()
    }
  }

  func previous() {
    guard validSession(), current != nil else { return }
    updatePosition()
    persist()
    let autoplay = isPlaying
    queue?.previous()
    do { try loadCurrent(autoplay: autoplay) } catch { failed() }
  }

  func tick(now: Date = Date()) {
    guard validSession(), isPlaying else { return }
    updatePosition()
    if now.timeIntervalSince(lastPersist) >= 5 { persist(now: now) }
    publish()
  }

  func backgrounded() {
    guard validSession() else { return }
    updatePosition()
    persist()
  }

  func shutdown() {
    guard !closed else { return }
    if isActive() { updatePosition(); persist() }
    closed = true
    ticker?.cancel()
    ticker = nil
    audioLoaded = false
    driver.stop()
    driver.onFinish = nil
    driver.onFailure = nil
    protectPlaying(nil)
    isPlaying = false
    queue = nil
    remote.clear()
    for observer in observers { notifications.removeObserver(observer) }
    observers.removeAll()
    audioSession.deactivate()
  }

  private func loadCurrent(autoplay: Bool) throws {
    audioLoaded = false
    driver.stop()
    protectPlaying(nil)
    isPlaying = false
    guard let current else { publish(); return }
    let url = try resolve(current)
    guard url.isFileURL else { throw LocalAudioDriver.Failure.notLocal }
    protectPlaying(current.id)
    try driver.load(url)
    audioLoaded = true
    driver.position = position
    if autoplay {
      try audioSession.activate()
      try driver.play(rate: Float(speed))
      isPlaying = true
    }
    publish()
  }

  private func finished() {
    guard validSession(), let current else { return }
    queue?.seek(to: current.duration)
    persist()
    markHeard(current.id)
    // Listening is not a consume action. Only the explicit button uses the action endpoint.
    if queue?.advance() == true {
      do { try loadCurrent(autoplay: true) } catch { failed() }
    } else {
      audioLoaded = false
      driver.stop()
      protectPlaying(nil)
      isPlaying = false
      publish()
    }
  }

  private func updatePosition() {
    if audioLoaded && current != nil && queue?.isFinished != true {
      queue?.seek(to: driver.position)
    }
  }
  private func persist(now: Date = Date()) {
    guard isActive(), let current else { return }
    resume.record(current, position: position)
    do { try persistence.write(resume); lastPersist = now } catch {
      message = "Couldn't save your place on this device."
    }
  }
  private func publish() {
    remote.update(
      current.map { PlayerNowPlaying(item: $0, position: position, rate: isPlaying ? speed : 0) })
  }
  private func failed() {
    audioLoaded = false
    driver.stop()
    protectPlaying(nil)
    isPlaying = false
    message = "This audio isn't available. Prepare it again in Saved."
    publish()
  }
  private func validSession() -> Bool {
    guard !closed else { return false }
    if !isActive() { shutdown(); return false }
    return true
  }

  private func observeSystemEvents() {
    observers.append(
      notifications.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
        let options =
          (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
        Task { @MainActor in self?.interruption(type: type, options: options) }
      })
    observers.append(
      notifications.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] note in
        let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
        Task { @MainActor in
          if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
            self?.pause()
          }
        }
      })
    observers.append(
      notifications.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        Task { @MainActor in self?.backgrounded() }
      })
  }

  private func interruption(type: UInt?, options: UInt) {
    guard validSession() else { return }
    if type == AVAudioSession.InterruptionType.began.rawValue {
      let playing = isPlaying
      pause()
      resumeAfterInterruption = playing
    } else if type == AVAudioSession.InterruptionType.ended.rawValue {
      let shouldPlay =
        resumeAfterInterruption
        && AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
      resumeAfterInterruption = false
      if shouldPlay { play() }
    }
  }
}
