import Foundation
import XCTest

@testable import LaterKit

final class CaptureDeliveryTests: XCTestCase, @unchecked Sendable {
  func testOfflineRetryKeepsSameRequestIDAndRepeatedIsSuccess() async throws {
    let owner = UUID()
    let request = CaptureRequest(url: "https://example.com")
    let storage = MemoryCaptureOutbox([PendingCapture(request: request, ownerID: owner)])
    let api = CaptureTestAPI(
      results: [.failure(.server(status: 503, message: nil)), .success(receipt)])
    let drainer = CaptureOutboxDrainer(storage: storage, delivery: CaptureDelivery(api: api))
    let offline = try await drainer.drain(ownerID: owner)
    XCTAssertEqual(offline.saved, 0)
    let pending = await storage.pending()
    XCTAssertEqual(pending.count, 1)
    let online = try await drainer.drain(ownerID: owner)
    XCTAssertEqual(online.saved, 1)
    _ = try await drainer.drain(ownerID: owner)
    let sent = await api.requests
    XCTAssertEqual(sent.count, 2)
    XCTAssertEqual(sent[0].body, sent[1].body)
    XCTAssertEqual(sent[0].path, "api/app/captures")
    XCTAssertEqual(sent[0].method, .post)
    let remaining = await storage.pending()
    XCTAssertTrue(remaining.isEmpty)
  }

  func testSignedOutRetainsEntryAndInvalidDropsEntry() async throws {
    let owner = UUID()
    let capture = PendingCapture(request: CaptureRequest(text: "Read this"), ownerID: owner)
    let storage = MemoryCaptureOutbox([capture])
    let api = CaptureTestAPI(
      results: [.failure(.sessionEnded), .failure(.server(status: 400, message: nil))])
    let drainer = CaptureOutboxDrainer(storage: storage, delivery: CaptureDelivery(api: api))
    let signedOut = try await drainer.drain(ownerID: owner)
    XCTAssertTrue(signedOut.signInRequired)
    let pending = await storage.pending()
    XCTAssertEqual(pending, [capture])
    let invalid = try await drainer.drain(ownerID: owner)
    XCTAssertEqual(invalid.invalid, 1)
    let remaining = await storage.pending()
    XCTAssertTrue(remaining.isEmpty)
  }

  func testOtherAccountAndUnassignedSharesAreNeverSent() async throws {
    let storage = MemoryCaptureOutbox([
      PendingCapture(request: CaptureRequest(text: "Private"), ownerID: UUID()),
      PendingCapture(request: CaptureRequest(text: "Signed out"), ownerID: nil),
    ])
    let api = CaptureTestAPI(results: [])
    let drainer = CaptureOutboxDrainer(storage: storage, delivery: CaptureDelivery(api: api))
    _ = try await drainer.drain(ownerID: UUID())
    let sent = await api.requests
    XCTAssertTrue(sent.isEmpty)
    let pending = await storage.pending()
    XCTAssertEqual(pending.count, 2)
  }

  func testMalformedSuccessRetainedAndInvalidLocalPayloadNotSent() async throws {
    let api = CaptureTestAPI(results: [.success(Data("{}".utf8))])
    let delivery = CaptureDelivery(api: api)
    let malformed = try await delivery.send(CaptureRequest(text: "Read"))
    XCTAssertEqual(malformed, .retryLater)
    let invalid = try await delivery.send(CaptureRequest(url: "file:///private"))
    XCTAssertEqual(invalid, .invalid)
    let sent = await api.requests
    XCTAssertEqual(sent.count, 1)
  }

  private var receipt: Data {
    Data("{\"captureId\":\"00000000-0000-4000-8000-000000000001\",\"repeated\":true}".utf8)
  }
}

private actor MemoryCaptureOutbox: CaptureOutboxStorage {
  var items: [PendingCapture]

  init(_ items: [PendingCapture]) { self.items = items }
  func pending() -> [PendingCapture] { items }
  func insert(_ capture: PendingCapture) { items.append(capture) }
  func remove(requestID: UUID) { items.removeAll { $0.request.requestId == requestID } }
}

private actor CaptureTestAPI: LaterAPIClient {
  var requests: [LaterAPIRequest] = []
  var results: [Result<Data, LaterAPIError>]

  init(results: [Result<Data, LaterAPIError>]) { self.results = results }
  func send(_ request: LaterAPIRequest) throws -> Data {
    requests.append(request)
    guard !results.isEmpty else { throw LaterAPIError.invalidResponse }
    return try results.removeFirst().get()
  }
}
