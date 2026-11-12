import AVFoundation
import Foundation
import LaterKit
import Observation

struct RenderedNarration {
  let file: URL
  let voiceID: String
}

@MainActor
protocol NarrationRendering {
  func render(_ text: NarrationText, in directory: URL) async throws -> RenderedNarration
  func cancel()
}

@MainActor
@Observable
final class NarrationStore {
  private(set) var snapshot: NarrationSnapshot
  private(set) var preparing: UUID?
  private(set) var message: String?
  /// Playback will set this before opening a file and clear it after closing it (later-0031).
  var playingID: UUID?
  private let service: NarrationService
  private let renderer: any NarrationRendering
  let files: NarrationFiles
  private let isActive: () -> Bool
  private let cap: Int64
  private var draining = false
  private var restartAfterDrain = false
  private var stopped = false
  private var desired: [UUID: String] = [:]

  init(
    client: any LaterAPIClient, renderer: any NarrationRendering, files: NarrationFiles,
    cap: Int64 = 500 * 1_024 * 1_024, isActive: @escaping () -> Bool = { true }
  ) throws {
    service = NarrationService(client: client)
    self.renderer = renderer
    self.files = files
    self.cap = cap
    self.isActive = isActive
    snapshot = try files.load()
    desired = Dictionary(
      snapshot.pending.map { ($0.id, $0.version) }, uniquingKeysWith: { _, new in new })
    try files.removeOrphans(keeping: snapshot.manifests)
  }

  func manifest(for item: LaterKit.LibraryItem) -> NarrationManifest? {
    guard item.listen.state == .narratable, snapshot.conflicts[item.id] == nil,
      let value = snapshot.manifests[item.id], value.textVersion == item.listen.textVersion
    else { return nil }
    return value
  }

  /// Auto-queue only the newest ten; explicit requests survive refresh and process serially.
  func enqueueNewest(_ items: [LaterKit.LibraryItem]) {
    let candidates = items.filter { $0.listen.state == .narratable }.sorted {
      ($0.savedDate ?? .distantPast) > ($1.savedDate ?? .distantPast)
    }.prefix(10)
    let automaticIDs = Set(candidates.map(\.id))
    var next = snapshot
    next.pending.removeAll { !automaticIDs.contains($0.id) && !next.explicit.contains($0.id) }
    commit(next)
    for item in items {
      desired[item.id] = item.listen.state == .narratable ? item.listen.textVersion : nil
    }
    for item in candidates { enqueue(item, explicit: false) }
  }

  func enqueue(_ item: LaterKit.LibraryItem, explicit: Bool = true) {
    guard isActive(), item.listen.state == .narratable, let version = item.listen.textVersion else {
      return
    }
    desired[item.id] = version
    guard manifest(for: item) == nil else { return }
    let candidate = NarrationCandidate(id: item.id, version: version)
    var next = snapshot
    if explicit { next.explicit.insert(item.id) }
    next.pending.removeAll { $0.id == item.id }
    next.pending.append(candidate)
    next.conflicts[item.id] = nil
    commit(next)
  }

  func pause() {
    stopped = true
    restartAfterDrain = false
    renderer.cancel()
  }

  /// One drain owns the renderer. Expiration/cancellation leaves the queue retryable.
  func process() async {
    guard isActive() else { return }
    if draining {
      if stopped { restartAfterDrain = true }
      return
    }
    draining = true
    stopped = false
    message = nil
    defer {
      draining = false
      preparing = nil
      if restartAfterDrain {
        restartAfterDrain = false
        Task { await process() }
      }
    }
    var attempted: [NarrationCandidate] = []
    while let candidate = snapshot.pending.first(where: { !attempted.contains($0) }) {
      attempted.append(candidate)
      guard !stopped, !Task.isCancelled, isActive() else { break }
      guard desired[candidate.id] == candidate.version, candidate.id != playingID else { continue }
      preparing = candidate.id
      do {
        try await prepare(candidate)
      } catch is CancellationError {
        break
      } catch NarrationError.openOriginal(let reason) {
        guard isActive(), !stopped, desired[candidate.id] == candidate.version else { break }
        var next = snapshot
        next.pending.removeAll { $0.id == candidate.id }
        next.conflicts[candidate.id] = reason
        let previous = next.manifests.removeValue(forKey: candidate.id)
        if commit(next), let previous { try? files.remove(previous.directory) }
      } catch {
        guard isActive(), !stopped else { break }
        message = "Couldn't prepare audio. Connect and tap Prepare to try again."
        // Avoid ten repeated requests when connectivity, storage or the voice is unavailable.
        break
      }
    }
  }

  private func prepare(_ candidate: NarrationCandidate) async throws {
    let text = try await service.text(for: candidate.id)
    try checkActive(candidate)
    guard text.textVersion == candidate.version else { throw NarrationError.invalidText }
    let directoryID = UUID()
    let directory = try files.createWorkDirectory(directoryID)
    var published = false
    defer { if !published { try? files.remove(directoryID) } }
    let rendered = try await renderer.render(text, in: directory)
    try checkActive(candidate)
    guard
      rendered.file.deletingLastPathComponent().standardizedFileURL
        == directory.standardizedFileURL,
      ["audio.caf", "audio.m4a"].contains(rendered.file.lastPathComponent)
    else { throw NarrationError.invalidText }
    let duration = try await AVURLAsset(url: rendered.file).load(.duration).seconds
    try checkActive(candidate)
    guard duration.isFinite, duration > 0 else { throw NarrationError.invalidText }
    try files.protect(rendered.file)
    let manifest = NarrationManifest(
      captureId: candidate.id, textVersion: text.textVersion, voiceID: rendered.voiceID,
      directory: directoryID, audioFile: rendered.file.lastPathComponent, duration: duration,
      renderedAt: Date(), lastHeard: snapshot.manifests[candidate.id]?.lastHeard)
    var next = snapshot
    let previous = next.manifests.updateValue(manifest, forKey: candidate.id)
    next.pending.removeAll { $0 == candidate }
    next.conflicts[candidate.id] = nil
    let evicted = try evict(&next, preserving: candidate.id)
    try files.save(next)
    snapshot = next
    published = true
    if let previous { try files.remove(previous.directory) }
    for value in evicted { try files.remove(value.directory) }
  }

  private func checkActive(_ candidate: NarrationCandidate) throws {
    try Task.checkCancellation()
    guard isActive(), !stopped, desired[candidate.id] == candidate.version else {
      throw CancellationError()
    }
  }

  private func evict(
    _ next: inout NarrationSnapshot, preserving id: UUID
  ) throws -> [NarrationManifest] {
    var total = try next.manifests.values.reduce(Int64(0)) { try $0 + files.bytes($1) }
    let ordered = next.manifests.values.filter { $0.captureId != playingID && $0.captureId != id }
      .sorted {
        if $0.lastHeard != $1.lastHeard {
          return ($0.lastHeard ?? .distantFuture) < ($1.lastHeard ?? .distantFuture)
        }
        return $0.renderedAt < $1.renderedAt
      }
    var removed: [NarrationManifest] = []
    for value in ordered where total > cap {
      total -= try files.bytes(value)
      next.manifests[value.captureId] = nil
      removed.append(value)
    }
    guard total <= cap else { throw CocoaError(.fileWriteOutOfSpace) }
    return removed
  }

  func markHeard(_ id: UUID, at date: Date = Date()) {
    var next = snapshot
    next.manifests[id]?.lastHeard = date
    commit(next)
  }

  @discardableResult
  private func commit(_ next: NarrationSnapshot) -> Bool {
    guard isActive() else { return false }
    do {
      try files.save(next)
      snapshot = next
      return true
    } catch {
      message = "Couldn't save audio preparation on this device. Please try again."
      return false
    }
  }
}
