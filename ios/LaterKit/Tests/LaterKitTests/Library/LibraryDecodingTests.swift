import Foundation
import XCTest

@testable import LaterKit

final class LibraryDecodingTests: XCTestCase {
  func testKnownStatesAndEveryReasonRoundTrip() throws {
    for state in ["narratable", "preparing", "open_original"] {
      for reason in OpenOriginalReason.allCases {
        let input =
          #"{"state":"\#(state)","reason":"\#(reason.rawValue)","wordCount":500,"textVersion":"abc"}"#
        let value = try decode(input)
        XCTAssertEqual(value.state.rawValue, state)
        XCTAssertEqual(value.reason, state == "open_original" ? reason : nil)
        XCTAssertEqual(value.wordCount, 500)
        XCTAssertEqual(value.textVersion, "abc")
        let roundTrip = try JSONDecoder().decode(
          LibraryListen.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(roundTrip, value)
      }
    }
  }

  func testUnknownStateOrReasonFallsBackWithoutClaimingNarration() throws {
    for input in [
      #"{"state":"future"}"#,
      #"{"state":"narratable","reason":"new_reason","wordCount":500}"#,
      #"{"state":"open_original","reason":"new_reason"}"#,
      #"{"state":"open_original"}"#,
    ] {
      let value = try decode(input)
      XCTAssertEqual(value.state, .openOriginal)
      XCTAssertEqual(value.reason, .unknown)
      XCTAssertNil(value.wordCount)
      XCTAssertNil(value.textVersion)
    }
  }

  func testLibraryNullableFieldsDatesAndOpaqueCursor() throws {
    let input =
      #"{"items":[{"captureId":"00000000-0000-4000-8000-000000000001","title":null,"creator":null,"source":null,"sourceUrl":null,"savedAt":"2026-11-12T12:00:00.000Z","kind":"other","listen":{"state":"preparing"}}],"nextCursor":"opaque+/="}"#
    let page = try JSONDecoder().decode(LibraryPage.self, from: Data(input.utf8))
    XCTAssertEqual(page.nextCursor, "opaque+/=")
    let item = try XCTUnwrap(page.items.first)
    XCTAssertEqual(item.id, item.captureId)
    XCTAssertNil(item.title)
    XCTAssertNil(item.sourceUrl)
    XCTAssertNotNil(item.savedDate)
    let withoutFraction = input.replacingOccurrences(of: ".000Z", with: "Z")
    let second = try JSONDecoder().decode(LibraryPage.self, from: Data(withoutFraction.utf8))
    XCTAssertEqual(second.items.first?.savedDate, item.savedDate)
    let invalid = input.replacingOccurrences(of: "2026-11-12T12:00:00.000Z", with: "invalid")
    XCTAssertNil(
      try JSONDecoder().decode(LibraryPage.self, from: Data(invalid.utf8)).items[0].savedDate)
    XCTAssertEqual(
      try JSONDecoder().decode(LibraryPage.self, from: JSONEncoder().encode(page)), page)
  }

  func testSafeDestinationRejectsExecutableURLsAndCredentials() throws {
    for value in [
      "javascript:alert(1)", "file:///tmp/private", "https://user:pass@example.org", "/path",
      "https://",
    ] {
      let bytes = try JSONSerialization.data(withJSONObject: [
        "status": "applied", "destination": value,
      ])
      XCTAssertNil(try JSONDecoder().decode(ItemActionResult.self, from: bytes).safeDestination)
    }
    for value in ["https://example.org/article", "http://example.org/article"] {
      let bytes = try JSONSerialization.data(withJSONObject: [
        "status": "applied", "destination": value,
      ])
      XCTAssertEqual(
        try JSONDecoder().decode(ItemActionResult.self, from: bytes).safeDestination?
          .absoluteString, value)
    }
    let noDestination = Data(#"{"status":"applied"}"#.utf8)
    XCTAssertNil(
      try JSONDecoder().decode(ItemActionResult.self, from: noDestination).safeDestination)
  }

  private func decode(_ input: String) throws -> LibraryListen {
    try JSONDecoder().decode(LibraryListen.self, from: Data(input.utf8))
  }
}

@MainActor
final class LibraryServiceTests: XCTestCase {
  func testPageUsesCursorOnlyWhenRequested() async throws {
    let client = LibraryClientStub(response: #"{"items":[],"nextCursor":null}"#)
    let service = LibraryService(client: client)
    _ = try await service.page()
    _ = try await service.page(before: "opaque+/=")
    let requests = await client.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[0].path, "api/app/library")
    XCTAssertEqual(requests[0].method, .get)
    XCTAssertEqual(requests[0].query, [URLQueryItem(name: "limit", value: "30")])
    XCTAssertEqual(requests[1].query.last, URLQueryItem(name: "before", value: "opaque+/="))
  }

  func testActionPostsSameIDWithClosedActionBody() async throws {
    let client = LibraryClientStub(
      response: #"{"status":"applied","destination":"https://example.org"}"#)
    let service = LibraryService(client: client)
    let pending = PendingItemAction(captureId: UUID(), action: .open)
    _ = try await service.perform(pending)
    _ = try await service.perform(pending)
    let requests = await client.requests
    XCTAssertEqual(requests[0].method, .post)
    XCTAssertEqual(requests[0].path, "api/revisit/actions/\(pending.captureId.uuidString)")
    XCTAssertEqual(
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(requests[0].body)),
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(requests[1].body)))
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: XCTUnwrap(requests[0].body)) as? [String: String])
    XCTAssertEqual(body, ["requestId": pending.requestId.uuidString, "action": "open"])
    XCTAssertEqual(pending.id, pending.requestId)
    XCTAssertEqual(
      try JSONDecoder().decode(PendingItemAction.self, from: JSONEncoder().encode(pending)), pending
    )
  }

  func testUnavailableAndUnsafeOpenResultsFailButConsumeNeedsNoDestination() async throws {
    for response in [
      #"{"status":"unavailable"}"#, #"{"status":"applied"}"#,
      #"{"status":"applied","destination":"file:///private"}"#,
    ] {
      let service = LibraryService(client: LibraryClientStub(response: response))
      do {
        _ = try await service.perform(PendingItemAction(captureId: UUID(), action: .open))
        XCTFail("Unsafe original accepted")
      } catch {
        XCTAssertEqual(error as? LaterAPIError, .server(status: 409, message: nil))
      }
    }
    let service = LibraryService(client: LibraryClientStub(response: #"{"status":"applied"}"#))
    let result = try await service.perform(PendingItemAction(captureId: UUID(), action: .consume))
    XCTAssertEqual(result.status, "applied")
    XCTAssertNil(result.safeDestination)
  }
}

private actor LibraryClientStub: LaterAPIClient {
  var requests: [LaterAPIRequest] = []
  let response: String
  init(response: String) { self.response = response }
  func send(_ request: LaterAPIRequest) -> Data {
    requests.append(request)
    return Data(response.utf8)
  }
}
