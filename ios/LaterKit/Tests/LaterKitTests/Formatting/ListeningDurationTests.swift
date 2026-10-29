import XCTest

@testable import LaterKit

final class ListeningDurationTests: XCTestCase {
  func testFormatsWholeMinutesRoundingUp() {
    XCTAssertEqual(ListeningDuration.format(.seconds(0)), "0 min")
    XCTAssertEqual(ListeningDuration.format(.milliseconds(500)), "1 min")
    XCTAssertEqual(ListeningDuration.format(.seconds(59)), "1 min")
    XCTAssertEqual(ListeningDuration.format(.seconds(60)), "1 min")
    XCTAssertEqual(ListeningDuration.format(.milliseconds(60_500)), "2 min")
    XCTAssertEqual(ListeningDuration.format(.seconds(9 * 60 + 30)), "10 min")
  }

  func testFormatsHours() {
    XCTAssertEqual(ListeningDuration.format(.seconds(3600)), "1 hr")
    XCTAssertEqual(ListeningDuration.format(.seconds(3600 + 5 * 60)), "1 hr 5 min")
    XCTAssertEqual(ListeningDuration.format(.seconds(2 * 3600 - 1)), "2 hr")
  }

  func testNegativeDurationsFormatAsZero() {
    XCTAssertEqual(ListeningDuration.format(.seconds(-90)), "0 min")
  }

  func testListsTheSlots() {
    XCTAssertEqual(ListeningDuration.list(ListeningDuration.slots), "10 min, 15 min or 30 min")
    XCTAssertEqual(ListeningDuration.list([.seconds(600), .seconds(900)]), "10 min or 15 min")
    XCTAssertEqual(ListeningDuration.list([.seconds(600)]), "10 min")
    XCTAssertEqual(ListeningDuration.list([]), "")
  }
}
