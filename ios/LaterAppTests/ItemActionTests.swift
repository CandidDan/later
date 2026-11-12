import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class ItemActionTests: XCTestCase {
  func testPostsDurableActionBeforeReturningDestinationForNavigation() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    await client.setDelay(50_000_000)
    let item = try SavedFixtures.item()
    var navigated: URL?
    let action = Task { navigated = await model.perform(.open, on: item) }
    while !model.isSending { await Task.yield() }
    XCTAssertEqual(cache.value?.pending.count, 1, "The ID must survive process death before POST")
    XCTAssertNil(navigated)
    let duplicate = await model.perform(.open, on: item)
    XCTAssertNil(duplicate)
    await action.value
    XCTAssertEqual(navigated?.absoluteString, "https://example.org/returned")
    XCTAssertNotEqual(navigated?.absoluteString, item.sourceUrl, "Use the server destination")
    XCTAssertEqual(model.pendingCount, 0)
    XCTAssertEqual(cache.value?.pending.count, 0)
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 1)
  }

  func testUnavailableNeverNavigatesAndRemovesTerminalAction() async throws {
    let client = SavedAPIStub()
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    await model.start()
    await client.setFailure(LaterAPIError.server(status: 409, message: "unavailable"))
    let url = await model.perform(.open, on: try SavedFixtures.item())
    XCTAssertNil(url)
    XCTAssertEqual(model.message, "This original isn't available.")
    XCTAssertEqual(model.pendingCount, 0)
    await client.setFailure(nil)
    await model.retryPending()
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 1)
  }

  func testOfflineActionRetriesIdempotently() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    await client.setFailure(URLError(.networkConnectionLost))
    let url = await model.perform(.open, on: try SavedFixtures.item())
    XCTAssertNil(url)
    XCTAssertEqual(model.pendingCount, 1)
    XCTAssertTrue(model.isOffline)
    let persistedID = try XCTUnwrap(cache.value?.pending.first?.requestId)
    // Relaunch from the durable queue, then recover connectivity.
    await client.setFailure(nil)
    let resumed = SavedViewModel(client: client, cache: cache)
    await resumed.start()
    await resumed.retryPending()
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 2, "One uncertain attempt and one successful retry")
    XCTAssertEqual(
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[0].body)),
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[1].body)))
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: XCTUnwrap(posts[1].body)) as? [String: String])
    XCTAssertEqual(body["requestId"], persistedID.uuidString)
    XCTAssertEqual(resumed.pendingCount, 0)
    XCTAssertEqual(cache.value?.pending.count, 0)
  }

  func testManualRetryAfterServerFailureReusesIDAndConsumeIsExplicit() async throws {
    let client = SavedAPIStub()
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    await model.start()
    let item = try SavedFixtures.item()
    await client.setFailure(LaterAPIError.server(status: 503, message: "private"))
    _ = await model.perform(.consume, on: item)
    XCTAssertFalse(model.isOffline)
    XCTAssertEqual(model.message, "Couldn't finish this action. Please try again.")
    await client.setFailure(nil)
    _ = await model.perform(.consume, on: item)
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 2)
    XCTAssertEqual(
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[0].body)),
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[1].body)))
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: XCTUnwrap(posts[1].body)) as? [String: String])
    XCTAssertEqual(body["action"], "consume")
    XCTAssertEqual(model.message, "Marked done.")
  }

  func testCannotSendAnActionThatWasNotDurablyQueued() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    cache.failWrite = true
    let result = await model.perform(.open, on: try SavedFixtures.item())
    XCTAssertNil(result)
    XCTAssertEqual(model.pendingCount, 0)
    XCTAssertEqual(model.message, "Couldn't save this action on this device. Please try again.")
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertTrue(posts.isEmpty)
  }

  func testReplayStopsAtFirstTransientFailureWithoutDroppingLaterActions() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let first = PendingItemAction(captureId: UUID(), action: .open)
    let second = PendingItemAction(captureId: UUID(), action: .consume)
    cache.value = SavedSnapshot(pending: [first, second])
    await client.setFailure(URLError(.notConnectedToInternet))
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    XCTAssertEqual(cache.value?.pending, [first, second])
    var posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 1)
    await client.setFailure(nil)
    await model.reconnect()
    posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 3)
    XCTAssertEqual(model.pendingCount, 0)
  }

  func testAcknowledgementWriteFailureRetainsIDForSafeRetry() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    await client.setDelay(50_000_000)
    let item = try SavedFixtures.item()
    let task = Task { await model.perform(.open, on: item) }
    while !model.isSending { await Task.yield() }
    cache.failWrite = true
    let destination = await task.value
    XCTAssertNil(destination)
    XCTAssertEqual(model.pendingCount, 1)
    cache.failWrite = false
    await model.retryPending()
    let posts = await client.requests.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 2)
    XCTAssertEqual(
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[0].body)),
      try JSONDecoder().decode([String: String].self, from: XCTUnwrap(posts[1].body)))
    XCTAssertEqual(model.pendingCount, 0)
  }
}
