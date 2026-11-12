import Foundation
import XCTest

@testable import LaterKit

final class PlaybackQueueTests: XCTestCase {
  func testAdvancePreviousSkipAndSpeedAdjustedRemaining() throws {
    let first = item(duration: 100, start: 20)
    let second = item(duration: 200, start: 50)
    var queue = try PlaybackQueue(items: [first, second])
    XCTAssertEqual(queue.current, first)
    XCTAssertEqual(queue.position, 20)
    XCTAssertEqual(queue.remaining(), 230)
    XCTAssertEqual(queue.remaining(at: 2), 115)
    queue.skip(30)
    XCTAssertEqual(queue.position, 50)
    queue.previous()
    XCTAssertEqual(queue.index, 0)
    XCTAssertEqual(queue.position, 0)
    XCTAssertTrue(queue.advance())
    XCTAssertEqual(queue.position, 50)
    queue.previous()
    XCTAssertEqual(queue.index, 1, "After three seconds, previous restarts the same item")
    queue.previous()
    XCTAssertEqual(queue.index, 0)
    queue.skip(-100)
    XCTAssertEqual(queue.position, 0)
    queue.seek(to: 500)
    XCTAssertEqual(queue.position, 100)
    XCTAssertEqual(queue.index, 0, "A seek does not silently consume or advance an item")
    XCTAssertTrue(queue.advance())
    XCTAssertFalse(queue.advance())
    XCTAssertTrue(queue.isFinished)
    XCTAssertEqual(queue.remaining(), 0)
    queue.previous()
    XCTAssertFalse(queue.isFinished)
    XCTAssertEqual(queue.position, 0)
  }

  func testInvalidAndEmptyQueues() throws {
    var empty = try PlaybackQueue()
    XCTAssertNil(empty.current)
    XCTAssertFalse(empty.advance())
    empty.previous()
    empty.skip(30)
    XCTAssertEqual(empty.remaining(), 0)
    let duplicate = item(duration: 10)
    XCTAssertThrowsError(try PlaybackQueue(items: [duplicate, duplicate]))
    for duration in [Double.nan, .infinity, -1, 0] {
      XCTAssertThrowsError(try PlaybackQueue(items: [item(duration: duration)]))
    }
    XCTAssertThrowsError(try PlaybackQueue(items: [item(duration: 10, start: 11)]))
    var queue = try PlaybackQueue(items: [item(duration: 30)])
    queue.seek(to: .nan)
    queue.skip(.infinity)
    XCTAssertEqual(queue.position, 0)
    XCTAssertEqual(queue.remaining(at: 0), 0)
    XCTAssertEqual(queue.remaining(at: .nan), 0)
  }

  private func item(duration: Double, start: Double = 0) -> PlaybackItem {
    PlaybackItem(
      captureId: UUID(), textVersion: "v1", title: "Title", source: "Example", duration: duration,
      startPosition: start)
  }
}
