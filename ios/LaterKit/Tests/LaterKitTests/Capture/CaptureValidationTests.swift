import Foundation
import XCTest

@testable import LaterKit

final class CaptureValidationTests: XCTestCase {
  func testWireBodyHasOnlyCaptureFields() throws {
    let request = CaptureRequest(url: "https://example.com/read", note: "For my run")
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: request.encodedBody()) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["requestId", "url", "note", "sharedAt"])
    XCTAssertEqual(object["note"] as? String, "For my run")
    XCTAssertEqual(object["requestId"] as? String, request.requestId.uuidString)
  }

  func testTextOverLimitAndNonHTTPURLHaveReasons() {
    XCTAssertNotNil(CaptureRequest(text: String(repeating: "a", count: 16001)).validationMessage)
    for url in ["file:///private/read", "javascript:alert(1)", "https://", "https://a b.com"] {
      XCTAssertNotNil(CaptureRequest(url: url).validationMessage, url)
    }
  }

  func testLimitsUseUTF16AndAcceptBoundary() {
    XCTAssertNil(CaptureRequest(text: String(repeating: "🙂", count: 8000)).validationMessage)
    XCTAssertNotNil(CaptureRequest(text: String(repeating: "🙂", count: 8001)).validationMessage)
    XCTAssertNil(CaptureRequest(text: String(repeating: "a", count: 16000)).validationMessage)
    XCTAssertNotNil(
      CaptureRequest(text: "read", note: String(repeating: "a", count: 16001)).validationMessage)
    XCTAssertNotNil(
      CaptureRequest(url: "https://a.com/" + String(repeating: "a", count: 2000)).validationMessage)
  }

  func testEncodedByteLimitIncludesJSONEscapesAndMultibyteText() {
    let request = CaptureRequest(
      text: String(repeating: "界", count: 16000), note: String(repeating: "界", count: 16000))
    XCTAssertNotNil(request.validationMessage)
    XCTAssertThrowsError(try request.encodedBody())
    XCTAssertNotNil(
      CaptureRequest(text: String(repeating: "\u{0001}", count: 16000)).validationMessage)
  }

  func testEmptyShareRejectedAndContentPreserved() throws {
    XCTAssertNotNil(CaptureRequest().validationMessage)
    XCTAssertNotNil(CaptureRequest(text: " \n ").validationMessage)
    let request = CaptureRequest(text: "  My exact text\n", note: "")
    XCTAssertNil(request.validationMessage)
    XCTAssertEqual(
      try JSONDecoder().decode(CaptureRequest.self, from: request.encodedBody()), request)
  }
}
