import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class OutboxDrainTests: XCTestCase {
  func testBackgroundCompletionWaitsForCaptureDeliveryAndRejectsConfigurationFailure() async throws
  {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let storage = CaptureFileOutbox(parent: parent)
    try await storage.insert(PendingCapture(request: CaptureRequest(text: "Read"), ownerID: owner))
    let client = DrainTestClient(results: [
      .failure(.server(status: 503, message: nil)), .success(receipt),
    ])
    let captures = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { true })
    let narration = try NarrationStore(
      client: client, renderer: FixtureNarrationRenderer(),
      files: NarrationFiles(userID: owner, parent: parent))
    let state = AssignmentSessionState()
    let saved = SavedViewModel(
      client: client, cache: SavedFileCache(userID: owner, parent: parent),
      isActive: { state.active }, narration: narration)
    XCTAssertFalse(saved.backgroundWorkComplete, "A missing capture service is not success")
    saved.captures = captures
    _ = await captures.retry()
    XCTAssertFalse(saved.backgroundWorkComplete, "Pending captures prevent background success")
    _ = await captures.retry()
    XCTAssertTrue(saved.backgroundWorkComplete, "Both queues are now drained")
    saved.captureConfigurationNotice = "Couldn't open shared items"
    XCTAssertFalse(saved.backgroundWorkComplete)
    saved.captureConfigurationNotice = nil
    state.active = false
    XCTAssertFalse(saved.backgroundWorkComplete, "A stale session cannot report success")
  }

  func testOfflineThenRepeatedSuccessUsesSameIDAndRemovesEntry() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let storage = CaptureFileOutbox(parent: parent)
    let capture = PendingCapture(request: CaptureRequest(text: "Read this"), ownerID: owner)
    try await storage.insert(capture)
    let client = DrainTestClient(results: [
      .failure(.server(status: 503, message: nil)), .success(receipt),
    ])
    let model = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { true })
    let offline = await model.retry()
    XCTAssertEqual(offline, 0)
    XCTAssertTrue(model.hasPending)
    let online = await model.retry()
    XCTAssertEqual(online, 1)
    XCTAssertFalse(model.hasPending)
    _ = await model.retry()
    let requests = await client.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[0].body, requests[1].body)
    let pending = try await storage.pending()
    XCTAssertTrue(pending.isEmpty)
  }

  func testInvalidIsDroppedVisiblyAndNoticeSurvivesRelaunch() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let storage = CaptureFileOutbox(parent: parent)
    try await storage.insert(PendingCapture(request: CaptureRequest(text: "Read"), ownerID: owner))
    let client = DrainTestClient(results: [.failure(.server(status: 400, message: nil))])
    let model = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { true })
    _ = await model.retry()
    XCTAssertEqual(model.message, "Couldn't save a shared item. Please share it again.")
    let pending = try await storage.pending()
    XCTAssertTrue(pending.isEmpty)
    let reopened = CaptureFileOutbox(parent: parent)
    let next = CaptureRetryModel(
      ownerID: owner, storage: reopened, client: client, isActive: { true })
    _ = await next.retry()
    XCTAssertEqual(next.message, model.message)
    let anotherAccount = await reopened.hasRejection(ownerID: UUID())
    XCTAssertFalse(anotherAccount)
    await next.dismissNotice()
    let dismissed = await reopened.hasRejection(ownerID: owner)
    XCTAssertFalse(dismissed)
  }

  func testFailedNoticeWritePreservesRejectedShare() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let original = CaptureFileOutbox(parent: parent)
    try await original.insert(PendingCapture(request: CaptureRequest(text: "Read"), ownerID: owner))
    let failing = CaptureFileOutbox(parent: parent) { _, _, _ in
      throw CocoaError(.fileWriteOutOfSpace)
    }
    let model = CaptureRetryModel(
      ownerID: owner, storage: failing,
      client: DrainTestClient(results: [.failure(.server(status: 400, message: nil))]),
      isActive: { true })
    _ = await model.retry()
    let pending = try await original.pending()
    XCTAssertEqual(pending.count, 1)
    XCTAssertNotNil(model.message)
  }

  func testInactiveSessionAndOtherOwnersDoNotSend() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let storage = CaptureFileOutbox(parent: parent)
    try await storage.insert(PendingCapture(request: CaptureRequest(text: "Mine"), ownerID: owner))
    let client = DrainTestClient(results: [])
    let inactive = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { false })
    _ = await inactive.retry()
    let other = CaptureRetryModel(
      ownerID: UUID(), storage: storage, client: client, isActive: { true })
    _ = await other.retry()
    let requests = await client.requests
    XCTAssertTrue(requests.isEmpty)
    let pending = try await storage.pending()
    XCTAssertEqual(pending.count, 1)
  }

  func testConcurrentRetryIsSuppressedAndCancellationKeepsDurableEntry() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let owner = UUID()
    let storage = CaptureFileOutbox(parent: parent)
    try await storage.insert(PendingCapture(request: CaptureRequest(text: "Read"), ownerID: owner))
    let client = SuspendedDrainClient()
    let model = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { true })
    let first = Task { await model.retry() }
    await client.waitUntilRequested()
    let concurrent = await model.retry()
    XCTAssertEqual(concurrent, 0)
    first.cancel()
    await client.finish(receipt)
    let cancelled = await first.value
    XCTAssertEqual(cancelled, 0)
    let count = await client.count
    XCTAssertEqual(count, 1)
    let pending = try await storage.pending()
    XCTAssertEqual(pending.count, 1)
    XCTAssertNil(model.message)
  }

  func testSignedOutSharesWaitForConfirmationAndExcludeNewArrivals() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let storage = CaptureFileOutbox(parent: parent)
    let owner = UUID()
    let first = PendingCapture(request: CaptureRequest(text: "First"), ownerID: nil)
    try await storage.insert(first)
    let client = DrainTestClient(results: [.success(receipt)])
    let model = CaptureRetryModel(
      ownerID: owner, storage: storage, client: client, isActive: { true })
    _ = await model.retry()
    let beforeConfirmation = await client.requests
    XCTAssertTrue(beforeConfirmation.isEmpty)
    XCTAssertEqual(model.unassigned, [first])
    let second = PendingCapture(request: CaptureRequest(text: "Later arrival"), ownerID: nil)
    try await storage.insert(second)
    await model.assignConfirmed([first.request.requestId])
    let sent = await client.requests
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(sent.first?.body, try first.request.encodedBody())
    let pending = try await storage.pending()
    XCTAssertEqual(pending, [second])
    XCTAssertEqual(model.unassigned, [second])
  }

  func testAccountSwitchInvalidatesOpenConfirmation() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let storage = CaptureFileOutbox(parent: parent)
    let capture = PendingCapture(request: CaptureRequest(text: "Read"), ownerID: nil)
    try await storage.insert(capture)
    let state = AssignmentSessionState()
    let client = DrainTestClient(results: [])
    let model = CaptureRetryModel(
      ownerID: UUID(), storage: storage, client: client, isActive: { state.active })
    _ = await model.retry()
    state.active = false
    await model.assignConfirmed([capture.request.requestId])
    let pending = try await storage.pending()
    XCTAssertEqual(pending, [capture])
    let sent = await client.requests
    XCTAssertTrue(sent.isEmpty)
  }

  func testAssignmentSurvivesRecreationAndCannotChangeAccount() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let storage = CaptureFileOutbox(parent: parent)
    let owner = UUID()
    let capture = PendingCapture(request: CaptureRequest(text: "Read"), ownerID: nil)
    try await storage.insert(capture)
    try await storage.assign(requestID: capture.request.requestId, ownerID: owner)
    let reopened = CaptureFileOutbox(parent: parent)
    try await reopened.assign(requestID: capture.request.requestId, ownerID: owner)
    do {
      try await reopened.assign(requestID: capture.request.requestId, ownerID: UUID())
      XCTFail("An account choice must not be overwritten")
    } catch {}
    let pending = try await reopened.pending()
    XCTAssertEqual(pending.first?.ownerID, owner)
    XCTAssertEqual(pending.first?.request, capture.request)
    try await reopened.remove(requestID: capture.request.requestId)
    // A stale extension may put its original unassigned file back after app delivery.
    try await storage.insert(capture)
    let reinserted = try await reopened.pending()
    XCTAssertEqual(reinserted.first?.ownerID, owner)
  }

  func testAssignmentWriteFailureLeavesItemUnassigned() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let storage = CaptureFileOutbox(parent: parent)
    let capture = PendingCapture(request: CaptureRequest(text: "Read"), ownerID: nil)
    try await storage.insert(capture)
    let failing = CaptureFileOutbox(parent: parent) { _, _, _ in
      throw CocoaError(.fileWriteOutOfSpace)
    }
    do {
      try await failing.assign(requestID: capture.request.requestId, ownerID: UUID())
      XCTFail("A failed assignment must propagate")
    } catch {}
    let pending = try await storage.pending()
    XCTAssertEqual(pending, [capture])
  }

  func testConcurrentAccountAssignmentsHaveOneWinner() async throws {
    let parent = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let first = CaptureFileOutbox(parent: parent)
    let second = CaptureFileOutbox(parent: parent)
    let request = CaptureRequest(text: "Read")
    try await first.insert(PendingCapture(request: request, ownerID: nil))
    let firstOwner = UUID()
    let secondOwner = UUID()
    async let a = Self.attemptAssignment(first, requestID: request.requestId, ownerID: firstOwner)
    async let b = Self.attemptAssignment(second, requestID: request.requestId, ownerID: secondOwner)
    let results = await [a, b]
    XCTAssertEqual(results.filter { $0 }.count, 1)
    let pending = try await CaptureFileOutbox(parent: parent).pending()
    XCTAssertEqual(pending.first?.ownerID, results[0] ? firstOwner : secondOwner)
  }

  nonisolated private static func attemptAssignment(
    _ storage: CaptureFileOutbox, requestID: UUID, ownerID: UUID
  ) async -> Bool {
    do {
      try await storage.assign(requestID: requestID, ownerID: ownerID)
      return true
    } catch { return false }
  }

  private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  private var receipt: Data {
    Data(#"{"captureId":"00000000-0000-4000-8000-000000000001","repeated":true}"#.utf8)
  }
}

private actor DrainTestClient: LaterAPIClient {
  var requests: [LaterAPIRequest] = []
  var results: [Result<Data, LaterAPIError>]
  init(results: [Result<Data, LaterAPIError>]) { self.results = results }
  func send(_ request: LaterAPIRequest) throws -> Data {
    requests.append(request)
    guard !results.isEmpty else { throw LaterAPIError.invalidResponse }
    return try results.removeFirst().get()
  }
}

private actor SuspendedDrainClient: LaterAPIClient {
  var count = 0
  private var response: CheckedContinuation<Data, Never>?
  private var started: CheckedContinuation<Void, Never>?

  func send(_ request: LaterAPIRequest) async throws -> Data {
    count += 1
    return await withCheckedContinuation { continuation in
      response = continuation
      started?.resume()
      started = nil
    }
  }

  func waitUntilRequested() async {
    if response != nil { return }
    await withCheckedContinuation { started = $0 }
  }

  func finish(_ data: Data) {
    response?.resume(returning: data)
    response = nil
  }
}

@MainActor
private final class AssignmentSessionState {
  var active = true
}
