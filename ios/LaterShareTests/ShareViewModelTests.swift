import Foundation
import LaterKit
import XCTest

@MainActor
final class ShareViewModelTests: XCTestCase {
  func testURLAndNoteArePersistedBeforePOSTAndSuccessIsShown() async throws {
    let storage = ShareMemoryOutbox()
    let api = ShareTestAPI(storage: storage, result: .success(receipt))
    let model = ShareViewModel(
      url: "https://example.com/read", ownerID: UUID(), storage: storage,
      delivery: CaptureDelivery(api: api))
    model.note = "For my next run"
    await model.save()
    await model.save()
    let requests = await api.requests
    XCTAssertEqual(requests.count, 1)
    let body = try XCTUnwrap(requests.first?.body)
    let payload = try JSONDecoder().decode(CaptureRequest.self, from: body)
    XCTAssertEqual(payload.url, "https://example.com/read")
    XCTAssertEqual(payload.note, "For my next run")
    XCTAssertNil(payload.text)
    XCTAssertEqual(payload.requestId, model.persistedRequest?.requestId)
    XCTAssertNotNil(ISO8601DateFormatter().date(from: payload.sharedAt))
    XCTAssertEqual(model.message, "Saved for Later ✓")
    XCTAssertTrue(model.didSaveRemotely)
    let pending = await storage.pending()
    XCTAssertTrue(pending.isEmpty)
  }

  func testOfflineKeepsDurableRequest() async {
    let storage = ShareMemoryOutbox()
    let api = ShareTestAPI(storage: storage, result: .failure(.server(status: 503, message: nil)))
    let model = ShareViewModel(
      text: "Read this", ownerID: UUID(), storage: storage, delivery: CaptureDelivery(api: api))
    await model.save()
    XCTAssertEqual(model.message, "Saved — will send when you're online")
    XCTAssertFalse(model.didSaveRemotely)
    let pending = await storage.pending()
    XCTAssertEqual(pending.first?.request, model.persistedRequest)
  }

  func testSignedOut() async {
    let storage = ShareMemoryOutbox()
    let api = ShareTestAPI(storage: storage, result: .failure(.sessionEnded))
    let model = ShareViewModel(
      text: "Private", ownerID: UUID(), storage: storage, delivery: CaptureDelivery(api: api))
    await model.save()
    XCTAssertEqual(model.message, "Open Later to sign in")
    let pending = await storage.pending()
    XCTAssertEqual(pending.count, 1)
  }

  func testUnassignedShareNeverUsesAnAvailableToken() async {
    let storage = ShareMemoryOutbox()
    let api = ShareTestAPI(storage: storage, result: .success(receipt))
    let model = ShareViewModel(
      text: "Private", ownerID: nil, storage: storage, delivery: CaptureDelivery(api: api))
    await model.save()
    XCTAssertEqual(model.message, "Open Later to sign in")
    let requests = await api.requests
    XCTAssertTrue(requests.isEmpty)
    let pending = await storage.pending()
    XCTAssertEqual(pending.count, 1)
    XCTAssertNil(pending.first?.ownerID)
  }

  func testDiskFailureDoesNotSendOrClaimSuccess() async {
    let storage = ShareMemoryOutbox(failWrites: true)
    let api = ShareTestAPI(storage: storage, result: .success(receipt))
    let model = ShareViewModel(
      text: "Private", ownerID: UUID(), storage: storage, delivery: CaptureDelivery(api: api))
    await model.save()
    XCTAssertEqual(model.message, "Couldn't save. Please try again.")
    XCTAssertFalse(model.isFinished)
    XCTAssertNil(model.persistedRequest)
    let requests = await api.requests
    XCTAssertTrue(requests.isEmpty)
  }

  func testInvalidInputCannotSave() async {
    let storage = ShareMemoryOutbox()
    let model = ShareViewModel(
      url: "file:///private", ownerID: nil, storage: storage, delivery: nil)
    XCTAssertFalse(model.canSave)
    XCTAssertNotNil(model.validationMessage)
    await model.save()
    let pending = await storage.pending()
    XCTAssertTrue(pending.isEmpty)
  }

  private var receipt: Data {
    Data("{\"captureId\":\"00000000-0000-4000-8000-000000000001\",\"repeated\":false}".utf8)
  }
}

private actor ShareMemoryOutbox: CaptureOutboxStorage {
  private var items: [PendingCapture] = []
  private let failWrites: Bool
  init(failWrites: Bool = false) { self.failWrites = failWrites }
  func pending() -> [PendingCapture] { items }
  func insert(_ capture: PendingCapture) throws {
    if failWrites { throw CocoaError(.fileWriteOutOfSpace) }
    items.append(capture)
  }
  func remove(requestID: UUID) { items.removeAll { $0.request.requestId == requestID } }
}

private actor ShareTestAPI: LaterAPIClient {
  let storage: ShareMemoryOutbox
  let result: Result<Data, LaterAPIError>
  var requests: [LaterAPIRequest] = []
  init(storage: ShareMemoryOutbox, result: Result<Data, LaterAPIError>) {
    self.storage = storage
    self.result = result
  }
  func send(_ request: LaterAPIRequest) async throws -> Data {
    let pending = await storage.pending()
    XCTAssertEqual(pending.count, 1, "Persist before starting the network request")
    requests.append(request)
    return try result.get()
  }
}
