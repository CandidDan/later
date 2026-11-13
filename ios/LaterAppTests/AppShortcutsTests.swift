import AppIntents
import XCTest

@testable import Later

final class AppShortcutsTests: XCTestCase {
  func testProviderPublishesNamedShortcutAndAllSlots() {
    XCTAssertEqual(LaterShortcuts.appShortcuts.count, 1)
    XCTAssertEqual(SiriListenSlot.allCases.map(\.rawValue), [10, 15, 30])
    XCTAssertEqual(SiriListenSlot.ten.slot.duration, 600)
    XCTAssertEqual(SiriListenSlot.fifteen.slot.duration, 900)
    XCTAssertEqual(SiriListenSlot.thirty.slot.duration, 1800)
  }

  func testEveryPhraseIncludesApplicationName() throws {
    // AppShortcut's localized phrase representation is opaque. Verify the metadata source,
    // which Xcode's App Intents extractor also validates when building the target.
    let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent(
        "LaterApp/Services/Siri/PlayLaterIntent.swift")
    let text = try String(contentsOf: source, encoding: .utf8)
    let phrases = try XCTUnwrap(
      text.components(separatedBy: "phrases: [").last?.components(separatedBy: "],").first)
    let lines = phrases.split(separator: "\n").filter { $0.contains("\"") }
    XCTAssertEqual(lines.count, 3)
    XCTAssertTrue(lines.allSatisfy { $0.contains(".applicationName") })
    XCTAssertTrue(text.contains("shortTitle: \"Play Later\""))
  }
}
