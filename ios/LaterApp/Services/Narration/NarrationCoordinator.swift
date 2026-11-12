import BackgroundTasks
import Foundation
import LaterKit
import Observation

@MainActor
@Observable
final class NarrationCoordinator {
  static let backgroundIdentifier = "now.notfor.later.prepare-narration"
  private(set) var model: SavedViewModel?
  private(set) var player: PlayerEngine?
  var showingPlayer = false
  private(set) var configurationFailed = false
  private let auth: AuthService
  private var generation: Int?

  init(auth: AuthService) { self.auth = auth }

  /// Called during app construction, before launch completes. The same coordinator owns both
  /// foreground and background work, preventing concurrent renderers for the same account.
  func registerBackgroundTask() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.backgroundIdentifier, using: .main)
    {
      [weak self] task in
      let handle = BackgroundTaskHandle(task)
      Task { @MainActor in
        guard let self else { handle.finish(success: false); return }
        let work = Task { @MainActor in await self.resume() }
        handle.task.expirationHandler = {
          work.cancel()
          Task { @MainActor [weak self] in self?.pause() }
        }
        await work.value
        handle.finish(
          success: !work.isCancelled && self.model?.narration?.snapshot.pending.isEmpty == true)
        self.schedule()
      }
    }
  }

  func resume() async {
    await auth.restore()
    guard !Task.isCancelled else { return }
    guard auth.session != nil else {
      resetSession()
      return
    }
    if generation != auth.sessionGeneration || model == nil {
      pause()
      player?.shutdown()
      player = nil
      model = nil
      do {
        model = try SavedServiceFactory.make(auth: auth)
        generation = auth.sessionGeneration
        if let store = model?.narration, let userID = auth.session?.user.id {
          let sessionGeneration = auth.sessionGeneration
          player = PlayerEngine(
            persistence: ResumeFile(
              url: store.files.root.deletingLastPathComponent().appendingPathComponent(
                "playback.json")),
            resolve: { item in
              guard let manifest = store.snapshot.manifests[item.id],
                manifest.textVersion == item.textVersion,
                manifest.duration == item.duration
              else { throw LocalAudioDriver.Failure.unavailable }
              let url = store.files.audioURL(manifest).resolvingSymlinksInPath()
              let root = store.files.root.resolvingSymlinksInPath().path + "/"
              guard url.path.hasPrefix(root) else { throw LocalAudioDriver.Failure.notLocal }
              return url
            }, protectPlaying: { store.playingID = $0 }, markHeard: { store.markHeard($0) },
            isActive: { [weak auth] in
              auth?.session?.user.id == userID && auth?.sessionGeneration == sessionGeneration
            })
        }
        configurationFailed = false
      } catch {
        configurationFailed = true
        return
      }
    }
    await model?.start()
    await model?.narration?.process()
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--uitesting-player"), player?.current == nil,
        let items = model?.items, items.count >= 2
      {
        for _ in 0..<200 {
          if Task.isCancelled { return }
          if items.allSatisfy({ model?.narration?.manifest(for: $0) != nil }) { break }
          do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
        }
        startPlayback(items, autoplay: false)
      }
    #endif
    schedule()
  }

  func resetSession() {
    pause()
    player?.shutdown()
    player = nil
    showingPlayer = false
    model = nil
    generation = nil
  }

  func pause() { model?.narration?.pause() }

  @discardableResult
  func startPlayback(_ items: [LaterKit.LibraryItem], autoplay: Bool = true) -> Bool {
    guard let store = model?.narration, let player else { return false }
    let ready = items.compactMap { item -> PlaybackItem? in
      guard let manifest = store.manifest(for: item) else { return nil }
      return PlaybackItem(
        captureId: item.id, textVersion: manifest.textVersion,
        title: item.displayTitle, source: item.displaySource, duration: manifest.duration)
    }
    guard ready.count == items.count, !ready.isEmpty else { return false }
    do {
      try player.start(ready, autoplay: autoplay)
      return true
    } catch { return false }
  }

  func schedule() {
    guard auth.session != nil, model?.narration?.snapshot.pending.isEmpty == false else { return }
    let request = BGProcessingTaskRequest(identifier: Self.backgroundIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    // Scheduling is opportunistic; foreground preparation always remains available.
    try? BGTaskScheduler.shared.submit(request)
  }
}

/// The scheduler's callback is not actor-isolated. Access the task only on the main actor,
/// except for its documented expiration callback, which cancels the actor-owned work.
private final class BackgroundTaskHandle: @unchecked Sendable {
  let task: BGTask
  init(_ task: BGTask) { self.task = task }
  @MainActor func finish(success: Bool) {
    task.expirationHandler = nil
    task.setTaskCompleted(success: success)
  }
}
