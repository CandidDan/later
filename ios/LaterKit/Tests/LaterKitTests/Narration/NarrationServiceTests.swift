import Foundation
import XCTest

@testable import LaterKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class NarrationServiceTests: XCTestCase, @unchecked Sendable {
  func testOnlyExposedEndpointProvidesTextAndRejectsWrongCapture() async throws {
    let id = UUID()
    let client = NarrationClientStub(id: id)
    let text = try await NarrationService(client: client).text(for: id)
    XCTAssertEqual(text.captureId, id)
    let paths = await client.paths
    XCTAssertEqual(paths, ["api/app/narrations/\(id.uuidString)"])
    do {
      _ = try await NarrationService(client: client).text(for: UUID())
      XCTFail("Mismatched capture must be rejected")
    } catch { XCTAssertEqual(error as? NarrationError, .invalidText) }
  }

  func testConflictReasonSurvivesGeneralClientMapping() async throws {
    for reason in OpenOriginalReason.allCases {
      let transport = NarrationHTTPTransport(
        underlying: NarrationTransportStub(status: 409, reason: reason.rawValue))
      let client = try URLSessionLaterAPIClient(
        baseURL: try XCTUnwrap(URL(string: "https://example.org")),
        tokenProvider: NarrationTokenStub(), transport: transport)
      do {
        _ = try await NarrationService(client: client).text(for: UUID())
        XCTFail("A conflict must not return text")
      } catch { XCTAssertEqual(error as? NarrationError, .openOriginal(reason)) }
    }
    let transport = NarrationHTTPTransport(
      underlying: NarrationTransportStub(status: 200, reason: "future"))
    let (_, response) = try await transport.data(
      for: URLRequest(url: try XCTUnwrap(URL(string: "https://example.org"))))
    XCTAssertEqual(response.statusCode, 200)
    let unknown = NarrationHTTPTransport(
      underlying: NarrationTransportStub(status: 409, reason: "future"))
    do {
      _ = try await unknown.data(
        for: URLRequest(url: try XCTUnwrap(URL(string: "https://example.org"))))
      XCTFail("Unknown conflict must be safe")
    } catch { XCTAssertEqual(error as? NarrationError, .openOriginal(.unknown)) }
  }
}

private actor NarrationClientStub: LaterAPIClient {
  let id: UUID
  var paths: [String] = []
  init(id: UUID) { self.id = id }
  func send(_ request: LaterAPIRequest) throws -> Data {
    paths.append(request.path)
    return try JSONSerialization.data(withJSONObject: [
      "captureId": id.uuidString, "textVersion": "v1", "title": "Title",
      "sourceUrl": "https://example.org",
      "intro": "Intro.", "paragraphs": ["Full paragraph."], "outro": "End.", "wordCount": 2,
    ])
  }
}

private struct NarrationTransportStub: LaterHTTPTransport {
  let status: Int
  let reason: String
  func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
    let response = try XCTUnwrap(
      HTTPURLResponse(
        url: try XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: nil))
    return (try JSONSerialization.data(withJSONObject: ["reason": reason]), response)
  }
}

private struct NarrationTokenStub: TokenProvider {
  func accessToken() -> String { "fixture" }
  func refreshToken() -> String { "fixture" }
  func sessionEnded() {}
}
