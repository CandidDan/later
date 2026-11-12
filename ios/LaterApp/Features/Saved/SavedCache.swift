import Foundation
import LaterKit

struct SavedSnapshot: Codable {
  var items: [LibraryItem] = []
  var nextCursor: String?
  var hasLoaded = false
  var pending: [PendingItemAction] = []
}

@MainActor
protocol SavedCaching {
  func read() throws -> SavedSnapshot?
  func write(_ snapshot: SavedSnapshot) throws
}

/// Synchronous main-actor writes cannot race sign-out's synchronous cache deletion.
@MainActor
struct SavedFileCache: SavedCaching {
  let directory: URL
  var file: URL { directory.appendingPathComponent("saved.json") }

  init(userID: UUID, parent: URL) {
    directory = parent.appendingPathComponent(UserCacheCleaner.directoryName, isDirectory: true)
      .appendingPathComponent(userID.uuidString, isDirectory: true)
  }

  func read() throws -> SavedSnapshot? {
    do {
      return try JSONDecoder().decode(SavedSnapshot.self, from: Data(contentsOf: file))
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return nil
    }
  }

  func write(_ snapshot: SavedSnapshot) throws {
    let manager = FileManager.default
    try manager.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var location = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try location.setResourceValues(values)
    let bytes = try JSONEncoder().encode(snapshot)
    try bytes.write(
      to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
