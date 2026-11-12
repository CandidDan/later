import BackgroundTasks
import Foundation
import Observation

@MainActor
@Observable
final class NarrationCoordinator {
  static let backgroundIdentifier = "now.notfor.later.prepare-narration"
  private(set) var model: SavedViewModel?
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
      model = nil
      do {
        model = try SavedServiceFactory.make(auth: auth)
        generation = auth.sessionGeneration
        configurationFailed = false
      } catch {
        configurationFailed = true
        return
      }
    }
    await model?.start()
    await model?.narration?.process()
    schedule()
  }

  func resetSession() {
    pause()
    model = nil
    generation = nil
  }

  func pause() { model?.narration?.pause() }

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
