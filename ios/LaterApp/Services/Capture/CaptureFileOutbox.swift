import Foundation
import LaterKit

/// One immutable file per request avoids read/modify/write losses between the app and extension.
/// Put this directory in the shared App Group. Do not fall back to a private container when the
/// signed App Group is unavailable: that would report success for a share the app cannot see.
actor CaptureFileOutbox: CaptureOutboxStorage {
  enum StorageError: Error { case conflictingRequest }

  let directory: URL
  private let writeData: @Sendable (Data, URL, Data.WritingOptions) throws -> Void

  init(
    parent: URL,
    writeData: @escaping @Sendable (Data, URL, Data.WritingOptions) throws -> Void = {
      try $0.write(to: $1, options: $2)
    }
  ) {
    directory = parent.appendingPathComponent("LaterCaptureOutbox", isDirectory: true)
    self.writeData = writeData
  }

  func insert(_ capture: PendingCapture) throws {
    _ = try capture.request.encodedBody()
    let manager = FileManager.default
    try manager.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var location = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try location.setResourceValues(values)
    let destination = file(capture.request.requestId)
    if manager.fileExists(atPath: destination.path) {
      let previous = try JSONDecoder().decode(
        PendingCapture.self, from: Data(contentsOf: destination))
      guard previous == capture else { throw StorageError.conflictingRequest }
      return
    }
    try writeData(
      JSONEncoder().encode(capture), destination,
      [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func pending() throws -> [PendingCapture] {
    let files: [URL]
    do {
      files = try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return []
    }
    var captures: [PendingCapture] = []
    for file in files where file.pathExtension == "json" {
      guard UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil else {
        continue
      }
      do {
        let capture = try JSONDecoder().decode(PendingCapture.self, from: Data(contentsOf: file))
        guard file.lastPathComponent == self.file(capture.request.requestId).lastPathComponent
        else {
          throw StorageError.conflictingRequest
        }
        let assigned = try assignmentOwner(capture.request.requestId)
        if let original = capture.ownerID, let assigned, original != assigned {
          throw StorageError.conflictingRequest
        }
        captures.append(
          PendingCapture(request: capture.request, ownerID: capture.ownerID ?? assigned))
      } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
        // Another process completed this request after the directory listing.
        continue
      }
    }
    return captures.sorted { $0.request.sharedAt < $1.request.sharedAt }
  }

  func remove(requestID: UUID) throws {
    do {
      try FileManager.default.removeItem(at: file(requestID))
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }

  /// Persist a content-free notice before deleting the rejected share. A crash between the
  /// writes may retry the request, but cannot lose the failure notice or show another account's.
  func reject(_ capture: PendingCapture) throws {
    guard let owner = capture.ownerID else { throw StorageError.conflictingRequest }
    let notice = directory.appendingPathComponent("rejected-" + owner.uuidString)
    try writeData(
      Data("Couldn't save".utf8), notice,
      [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    try remove(requestID: capture.request.requestId)
  }

  func hasRejection(ownerID: UUID) -> Bool {
    FileManager.default.fileExists(
      atPath: directory.appendingPathComponent("rejected-" + ownerID.uuidString).path)
  }

  func dismissRejection(ownerID: UUID) throws {
    let notice = directory.appendingPathComponent("rejected-" + ownerID.uuidString)
    do { try FileManager.default.removeItem(at: notice) } catch let error as CocoaError
      where error.code == .fileNoSuchFile
    { return }
  }

  /// Assignment is a separate immutable record: concurrent app sessions cannot overwrite a
  /// previous account choice. Publish a fully protected file with an exclusive hard link so
  /// readers never see a partially written owner ID. Keep the record after delivery to prevent
  /// an interrupted extension from re-inserting the same request as unassigned.
  func assign(requestID: UUID, ownerID: UUID) throws {
    let capture = try JSONDecoder().decode(
      PendingCapture.self, from: Data(contentsOf: file(requestID)))
    guard capture.request.requestId == requestID, capture.ownerID == nil else {
      throw StorageError.conflictingRequest
    }
    if let assigned = try assignmentOwner(requestID) {
      guard assigned == ownerID else { throw StorageError.conflictingRequest }
      return
    }
    let temporary = directory.appendingPathComponent(".assignment-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: temporary) }
    try writeData(
      Data(ownerID.uuidString.utf8), temporary,
      [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    do {
      try FileManager.default.linkItem(at: temporary, to: assignmentFile(requestID))
    } catch {
      // Another process may have won. Only the identical choice is idempotent.
      guard try assignmentOwner(requestID) == ownerID else { throw error }
    }
  }

  private func assignmentOwner(_ requestID: UUID) throws -> UUID? {
    let data: Data
    do { data = try Data(contentsOf: assignmentFile(requestID)) } catch let error as CocoaError
      where error.code == .fileReadNoSuchFile
    { return nil }
    guard let text = String(data: data, encoding: .utf8), let owner = UUID(uuidString: text) else {
      throw StorageError.conflictingRequest
    }
    return owner
  }

  private func assignmentFile(_ id: UUID) -> URL {
    directory.appendingPathComponent("owner-" + id.uuidString)
  }

  private func file(_ id: UUID) -> URL {
    directory.appendingPathComponent(id.uuidString + ".json")
  }
}
