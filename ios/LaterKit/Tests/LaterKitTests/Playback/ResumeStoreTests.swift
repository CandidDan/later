import Foundation
import XCTest

@testable import LaterKit

final class ResumeStoreTests: XCTestCase {
  func testResumeFiveSecondsEarlierNearEndRestartAndVersionReset() throws {
    let id = UUID()
    let item = PlaybackItem(
      captureId: id, textVersion: "v1", title: "Title", source: "Example", duration: 100)
    var store = ResumeStore()
    XCTAssertEqual(store.startPosition(for: item), 0)
    store.record(item, position: 40)
    XCTAssertEqual(store.startPosition(for: item), 35)
    let restored = try JSONDecoder().decode(ResumeStore.self, from: JSONEncoder().encode(store))
    XCTAssertEqual(restored, store)
    let changed = PlaybackItem(
      captureId: id, textVersion: "v2", title: "Title", source: "Example", duration: 100)
    XCTAssertEqual(store.startPosition(for: changed), 0)
    store.record(item, position: 89)
    XCTAssertEqual(store.startPosition(for: item), 84)
    store.record(item, position: 90)
    XCTAssertEqual(store.startPosition(for: item), 0)
    store.record(item, position: 100)
    XCTAssertEqual(store.startPosition(for: item), 0)
    store.record(item, position: 3)
    XCTAssertEqual(store.startPosition(for: item), 0)
    store.record(item, position: .nan)
    XCTAssertEqual(store.positions[id]?.seconds, 3)
    store.record(changed, position: 20)
    XCTAssertEqual(store.startPosition(for: changed), 15)
    XCTAssertEqual(store.startPosition(for: item), 0)
  }
}
