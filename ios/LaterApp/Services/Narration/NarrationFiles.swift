import Foundation
import LaterKit

struct NarrationManifest: Codable, Equatable {
  let captureId: UUID
  let textVersion: String
  let voiceID: String
  let directory: UUID
  let audioFile: String
  let duration: TimeInterval
  let renderedAt: Date
  var lastHeard: Date?
}

struct NarrationCandidate: Codable, Equatable {
  let id: UUID
  let version: String
}

struct NarrationSnapshot: Codable {
  var manifests: [UUID: NarrationManifest] = [:]
  var pending: [NarrationCandidate] = []
  var explicit: Set<UUID> = []
  var conflicts: [UUID: OpenOriginalReason] = [:]
}

@MainActor
struct NarrationFiles {
  let root: URL
  private let write: (Data, URL, Data.WritingOptions) throws -> Void

  init(
    userID: UUID, parent: URL,
    write: @escaping (Data, URL, Data.WritingOptions) throws -> Void = {
      try $0.write(to: $1, options: $2)
    }
  ) {
    root = parent.appendingPathComponent(UserCacheCleaner.directoryName)
      .appendingPathComponent(userID.uuidString).appendingPathComponent("Narrations")
    self.write = write
  }

  func load() throws -> NarrationSnapshot {
    let url = root.appendingPathComponent("manifest.json")
    guard FileManager.default.fileExists(atPath: url.path) else { return NarrationSnapshot() }
    var snapshot = try JSONDecoder().decode(NarrationSnapshot.self, from: Data(contentsOf: url))
    snapshot.manifests = snapshot.manifests.filter { _, manifest in
      ["audio.caf", "audio.m4a"].contains(manifest.audioFile)
        && manifest.duration.isFinite && manifest.duration > 0
        && FileManager.default.fileExists(atPath: audioURL(manifest).path)
    }
    return snapshot
  }

  func save(_ snapshot: NarrationSnapshot) throws {
    try createDirectory(root)
    try write(
      JSONEncoder().encode(snapshot), root.appendingPathComponent("manifest.json"),
      [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func createWorkDirectory(_ id: UUID) throws -> URL {
    let url = root.appendingPathComponent(id.uuidString)
    try createDirectory(url)
    return url
  }

  func audioURL(_ manifest: NarrationManifest) -> URL {
    root.appendingPathComponent(manifest.directory.uuidString).appendingPathComponent(
      manifest.audioFile)
  }

  func remove(_ id: UUID) throws {
    let url = root.appendingPathComponent(id.uuidString)
    if FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.removeItem(at: url)
    }
  }

  func bytes(_ manifest: NarrationManifest) throws -> Int64 {
    let attributes = try FileManager.default.attributesOfItem(atPath: audioURL(manifest).path)
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0
  }

  func removeOrphans(keeping manifests: [UUID: NarrationManifest]) throws {
    guard FileManager.default.fileExists(atPath: root.path) else { return }
    let keep = Set(manifests.values.map(\.directory))
    for url in try FileManager.default.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil)
    {
      if let id = UUID(uuidString: url.lastPathComponent), !keep.contains(id) { try remove(id) }
    }
  }

  func protect(_ url: URL) throws {
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path)
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  private func createDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try protect(root)
    try protect(url)
  }
}
