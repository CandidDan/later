import Foundation

protocol UserCacheCleaning: Sendable {
  func clearAll() throws
}

/// All future downloaded user data belongs below these app-owned directories.
struct UserCacheCleaner: UserCacheCleaning {
  enum CleanupError: Error {
    case sharedContainerUnavailable
    case directoriesNotRemoved([URL])
  }

  static let directoryName = "LaterUserData"
  let directories: [URL]

  init(directories: [URL]) {
    self.directories = directories
  }

  static func live(appGroupIdentifier: String?) throws -> Self {
    let manager = FileManager.default
    var parents = [
      try manager.url(
        for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: false),
      try manager.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false),
      manager.temporaryDirectory,
    ]
    if let appGroupIdentifier {
      guard
        let group = manager.containerURL(
          forSecurityApplicationGroupIdentifier: appGroupIdentifier)
      else { throw CleanupError.sharedContainerUnavailable }
      parents += [
        group,
        group.appendingPathComponent("Library/Caches", isDirectory: true),
        group.appendingPathComponent("Library/Application Support", isDirectory: true),
      ]
    }
    return Self(
      directories: parents.map { $0.appendingPathComponent(directoryName, isDirectory: true) })
  }

  /// Attempt every directory even if one fails; callers must not report a clean sign-out on error.
  func clearAll() throws {
    // Keep Foundation's non-Sendable manager local to this operation.
    let fileManager = FileManager()
    var failed: [URL] = []
    for directory in directories {
      do {
        try fileManager.removeItem(at: directory)
      } catch let error as CocoaError where error.code == .fileNoSuchFile {
        continue
      } catch {
        failed.append(directory)
      }
    }
    if !failed.isEmpty { throw CleanupError.directoriesNotRemoved(failed) }
  }
}
