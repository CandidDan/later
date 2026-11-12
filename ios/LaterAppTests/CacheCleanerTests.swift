import Foundation
import XCTest

@testable import Later

final class CacheCleanerTests: XCTestCase {
  func testClearsOnlyAppOwnedRootsAndToleratesMissingDirectories() throws {
    let manager = FileManager.default
    let root = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: root) }
    let local = root.appendingPathComponent("local/LaterUserData")
    let shared = root.appendingPathComponent("shared/LaterUserData")
    let unrelated = root.appendingPathComponent("unrelated.txt")
    for directory in [local, shared] {
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data("private save".utf8).write(to: directory.appendingPathComponent("save.txt"))
    }
    try Data("keep".utf8).write(to: unrelated)
    let cleaner = UserCacheCleaner(
      directories: [local, shared, root.appendingPathComponent("missing")])
    try cleaner.clearAll()
    XCTAssertFalse(manager.fileExists(atPath: local.path))
    XCTAssertFalse(manager.fileExists(atPath: shared.path))
    XCTAssertEqual(try Data(contentsOf: unrelated), Data("keep".utf8))
    try cleaner.clearAll()
  }

  func testLiveCleanerWithoutAppGroupUsesOnlyAppOwnedSubdirectories() throws {
    let cleaner = try UserCacheCleaner.live(appGroupIdentifier: nil)
    XCTAssertEqual(cleaner.directories.count, 3)
    XCTAssertTrue(cleaner.directories.allSatisfy { $0.lastPathComponent == "LaterUserData" })
  }
}
