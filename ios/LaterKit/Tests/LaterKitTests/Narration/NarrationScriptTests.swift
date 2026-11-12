import Foundation
import XCTest

@testable import LaterKit

final class NarrationScriptTests: XCTestCase {
  func testIntroParagraphsAndOutroStayVerbatimInOrder() throws {
    let text = try fixture()
    let parts = NarrationScript.utterances(for: text)
    XCTAssertEqual(parts.map(\.text), [text.intro] + text.paragraphs + [text.outro])
    XCTAssertTrue(parts.allSatisfy { $0.pauseAfter == 0.3 })
  }

  func testChunkingIsLossless() {
    let sentence = "Dr. Jones read 3.14 pages.  Then she said, “Keep every word!”\n"
    let original = String(repeating: sentence, count: 80)
    let chunks = NarrationScript.chunks(original, target: 100)
    XCTAssertGreaterThan(chunks.count, 1)
    XCTAssertEqual(chunks.joined(), original)
    for chunk in chunks {
      XCTAssertTrue(chunk.hasSuffix("pages.  ") || chunk.hasSuffix("word!”\n"))
      XCTAssertFalse(chunk.hasSuffix("Dr. "))
    }
    let noBoundary = String(repeating: "one sentence ", count: 500)
    XCTAssertEqual(NarrationScript.chunks(noBoundary), [noBoundary])
    XCTAssertEqual(NarrationScript.chunks(""), [""])
    XCTAssertEqual(
      NarrationScript.chunks("A. B. Smith spoke. Next.", target: 1),
      ["A. B. Smith spoke. ", "Next."])
    XCTAssertEqual(NarrationScript.chunks("第一句话。第二句话！", target: 1).joined(), "第一句话。第二句话！")
  }

  func testLongParagraphUtterancesRejoinAndPauseOnlyAtParagraphEnd() throws {
    let text = try fixture(paragraphs: [String(repeating: "A complete sentence. ", count: 200)])
    let parts = NarrationScript.utterances(for: text)
    XCTAssertEqual(parts.first?.text, text.intro)
    XCTAssertEqual(parts.last?.text, text.outro)
    let paragraph = Array(parts.dropFirst().dropLast())
    XCTAssertEqual(paragraph.map(\.text).joined(), text.paragraphs[0])
    XCTAssertTrue(paragraph.dropLast().allSatisfy { $0.pauseAfter == 0 })
    XCTAssertEqual(paragraph.last?.pauseAfter, 0.3)
  }

  private func fixture(
    paragraphs: [String] = ["The first paragraph.", "  Second, exactly.\n"]
  ) throws -> NarrationText {
    let data = try JSONSerialization.data(withJSONObject: [
      "captureId": UUID().uuidString, "textVersion": "v1", "title": "Title",
      "sourceUrl": "https://example.org",
      "intro": "Title. From Example. Narrated by Later.", "paragraphs": paragraphs,
      "outro": "End of Title, from Example.", "wordCount": 10,
    ])
    return try JSONDecoder().decode(NarrationText.self, from: data)
  }
}
