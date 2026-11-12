import Foundation
import LaterKit
import Observation

struct ReadyListen: Equatable, Identifiable {
  let item: LibraryItem
  let duration: TimeInterval
  let position: TimeInterval
  var id: UUID { item.id }
  var candidate: ListenCandidate {
    ListenCandidate(
      id: id.uuidString, savedAt: item.savedDate ?? .distantPast,
      audioDuration: duration, position: position)
  }
}

struct ListenSnapshot {
  var ready: [ReadyListen] = []
  var preparing = 0
}

@MainActor
@Observable
final class ListenViewModel {
  private(set) var slot: ListenSlot = .fifteen
  private(set) var snapshot = ListenSnapshot()
  private(set) var plan: ListenPlan?
  private(set) var message: String?
  private let read: () throws -> ListenSnapshot
  private let start: ([LibraryItem]) -> Bool

  init(read: @escaping () throws -> ListenSnapshot, start: @escaping ([LibraryItem]) -> Bool) {
    self.read = read
    self.start = start
  }
  var planned: [ReadyListen] {
    (plan?.items ?? []).compactMap { planned in
      snapshot.ready.first { $0.id.uuidString == planned.id }
    }
  }
  var longer: [ReadyListen] {
    (plan?.tooLong ?? []).compactMap { candidate in
      snapshot.ready.first { $0.id.uuidString == candidate.id }
    }
  }
  var continuing: ReadyListen? {
    snapshot.ready.filter { $0.position > 0 }.sorted {
      if $0.item.savedDate != $1.item.savedDate {
        return ($0.item.savedDate ?? .distantPast) < ($1.item.savedDate ?? .distantPast)
      }
      return $0.id.uuidString < $1.id.uuidString
    }.first
  }
  func select(_ slot: ListenSlot) { self.slot = slot; refresh() }
  func refresh() {
    do {
      snapshot = try read()
      plan = try TimeFitPlanner.plan(target: slot, candidates: snapshot.ready.map(\.candidate))
      message = nil
    } catch {
      plan = nil
      snapshot = ListenSnapshot()
      message = "Couldn't read your listening plan. Please try again."
    }
  }
  @discardableResult
  func playPlan() -> Bool {
    let preview = plan
    let versions = planned.map { $0.item.listen.textVersion }
    refresh()
    guard let plan, !plan.items.isEmpty else { return false }
    guard preview == plan, versions == planned.map({ $0.item.listen.textVersion }) else {
      message = "Your ready audio changed. Review the updated plan, then tap Play."
      return false
    }
    return play(planned.map(\.item))
  }
  @discardableResult
  func playItem(_ id: UUID) -> Bool {
    refresh()
    guard let item = snapshot.ready.first(where: { $0.id == id }) else { return false }
    return play([item.item])
  }
  private func play(_ items: [LibraryItem]) -> Bool {
    guard start(items) else {
      message = "Couldn't start this audio. Try again from Saved."; return false
    }
    return true
  }

  static func makeSnapshot(
    items: [LibraryItem], resume: ResumeStore, pending: Set<UUID>,
    manifest: (LibraryItem) -> NarrationManifest?
  ) -> ListenSnapshot {
    var result = ListenSnapshot()
    for item in items {
      if item.listen.state == .narratable, let value = manifest(item),
        value.textVersion == item.listen.textVersion
      {
        let playback = PlaybackItem(
          captureId: item.id, textVersion: value.textVersion,
          title: item.displayTitle, source: item.displaySource, duration: value.duration)
        result.ready.append(
          ReadyListen(
            item: item, duration: value.duration, position: resume.startPosition(for: playback)))
      } else if item.listen.state == .preparing || pending.contains(item.id) {
        result.preparing += 1
      }
    }
    return result
  }

  static func live(_ coordinator: NarrationCoordinator) -> ListenViewModel {
    ListenViewModel(
      read: {
        coordinator.player?.backgrounded()  // Flush the current position before planning.
        guard let saved = coordinator.model, let store = saved.narration else {
          return ListenSnapshot()
        }
        let resume = try ResumeFile(
          url: store.files.root.deletingLastPathComponent().appendingPathComponent("playback.json")
        ).read()
        return makeSnapshot(
          items: saved.items, resume: resume, pending: Set(store.snapshot.pending.map(\.id)),
          manifest: { item in
            guard let value = store.manifest(for: item),
              FileManager.default.fileExists(atPath: store.files.audioURL(value).path)
            else { return nil }
            return value
          })
      }, start: { coordinator.startPlayback($0) })
  }
}
