import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class SavedViewModelTests: XCTestCase {
  func testEveryStatusAndReasonHasAnHonestLabelWithoutDuration() throws {
    for (state, expected) in [
      ("narratable", "Can be narrated"), ("preparing", "Preparing…"),
      ("open_original", "Open original"), ("future", "Open original"),
    ] {
      let item = try SavedFixtures.item(state: state)
      XCTAssertEqual(item.statusLabel, expected)
      XCTAssertFalse(item.accessibilitySummary.contains(" min"))
      XCTAssertFalse(item.accessibilitySummary.contains("~"))
      XCTAssertTrue(item.accessibilitySummary.contains("A quiet morning"))
      XCTAssertTrue(item.accessibilitySummary.contains("Example"))
      XCTAssertTrue(item.accessibilitySummary.contains(expected))
      if state == "narratable" || state == "preparing" { XCTAssertNil(item.reasonLabel) }
    }
    let labels: [OpenOriginalReason: String] = [
      .notAnArticle: "Not an article", .paywalled: "Behind a paywall",
      .truncated: "Only part of the text was available", .notHTML: "Not an article",
      .tooShort: "Couldn't read this page", .extractionFailed: "Couldn't read this page",
      .fetchFailed: "Couldn't read this page", .noSource: "Couldn't read this page",
      .unknown: "Couldn't read this page",
    ]
    for reason in OpenOriginalReason.allCases {
      XCTAssertEqual(
        try SavedFixtures.item(state: "open_original", reason: reason.rawValue).reasonLabel,
        labels[reason])
    }
    XCTAssertEqual(
      try SavedFixtures.item(state: "open_original", kind: "video").reasonLabel, "Video")
    XCTAssertEqual(
      try SavedFixtures.item(state: "open_original", kind: "post").reasonLabel, "Social post")
    let fallback = try SavedFixtures.item(title: nil)
    XCTAssertEqual(fallback.displayTitle, "Example · saved \(fallback.displayDate)")
    XCTAssertTrue(fallback.displayDate.contains("Nov"))
    XCTAssertEqual(
      try SavedFixtures.item(title: " ", date: "invalid").displayTitle,
      "Example · saved date unavailable")
  }

  func testPagesOnDemandOnly() async throws {
    let client = SavedAPIStub()
    let newest = try SavedFixtures.item(date: "2026-11-12T12:00:00Z")
    let older = try SavedFixtures.item(date: "2026-11-11T12:00:00Z")
    await client.setPages(
      first: try SavedFixtures.page([newest], cursor: "opaque"),
      next: try SavedFixtures.page([newest, older]))
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    await model.start()
    await model.start()
    var requests = await client.requests
    XCTAssertEqual(requests.count, 1, "Start must not crawl pages")
    XCTAssertEqual(model.items, [newest])
    await client.setDelay(30_000_000)
    let first = Task { await model.loadNextPage() }
    await Task.yield()
    await model.loadNextPage()
    await first.value
    await model.loadNextPage()
    requests = await client.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[1].query.last, URLQueryItem(name: "before", value: "opaque"))
    XCTAssertEqual(model.items, [newest, older], "Deduplicate overlap at page boundaries")
    XCTAssertFalse(model.hasNextPage)
    await client.setPages(first: try SavedFixtures.page([older]))
    await model.refresh()
    XCTAssertEqual(model.items, [older], "Refresh replaces old pages")
  }

  func testEmptyMeansOnlyASuccessfulEmptyFirstPage() async throws {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    let model = SavedViewModel(client: client, cache: cache)
    XCTAssertFalse(model.showEmpty)
    await client.setFailure(URLError(.notConnectedToInternet))
    await model.start()
    XCTAssertFalse(model.showEmpty)
    XCTAssertTrue(model.isOffline)
    await client.setFailure(LaterAPIError.server(status: 500, message: "private server detail"))
    await model.refresh()
    XCTAssertFalse(model.showEmpty)
    XCTAssertFalse(model.isOffline)
    XCTAssertEqual(model.message, "Couldn't load Saved. Please try again.")
    await client.setFailure(nil)
    await model.refresh()
    XCTAssertTrue(model.showEmpty)
    XCTAssertTrue(cache.value?.hasLoaded == true)
  }

  func testReadFailureCannotOverwritePendingActionsAndCanRetry() async {
    let client = SavedAPIStub()
    let cache = SavedMemoryCache()
    cache.failRead = true
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    await model.refresh()
    let requests = await client.requests
    XCTAssertTrue(requests.isEmpty)
    XCTAssertEqual(cache.writes, 0)
    XCTAssertNotNil(model.message)
    cache.failRead = false
    await model.reconnect()
    XCTAssertTrue(model.showEmpty)
  }

  func testCacheWriteFailureStillShowsLoadedRowsAndNotice() async throws {
    let client = SavedAPIStub()
    let item = try SavedFixtures.item()
    await client.setPages(first: try SavedFixtures.page([item]))
    let cache = SavedMemoryCache()
    cache.failWrite = true
    let model = SavedViewModel(client: client, cache: cache)
    await model.start()
    XCTAssertEqual(model.items, [item])
    XCTAssertEqual(model.message, "Couldn't keep this library offline. Please try again.")
  }

  func testRepeatedCursorDoesNotCrawlAndRowsAreNewestFirst() async throws {
    let client = SavedAPIStub()
    let old = try SavedFixtures.item(date: "2026-11-11T12:00:00Z")
    let new = try SavedFixtures.item()
    await client.setPages(
      first: try SavedFixtures.page([old, new], cursor: "same"),
      next: try SavedFixtures.page([], cursor: "same"))
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    await model.start()
    XCTAssertEqual(model.items, [new, old])
    await model.loadNextPage()
    await model.loadNextPage()
    let requests = await client.requests
    XCTAssertEqual(requests.count, 2)
  }
}

extension SavedViewModelTests {
  func testCancelledInitialLoadCanStartAgain() async throws {
    let client = SavedAPIStub()
    let item = try SavedFixtures.item()
    await client.setPages(first: try SavedFixtures.page([item]))
    await client.setDelay(100_000_000)
    let model = SavedViewModel(client: client, cache: SavedMemoryCache())
    let work = Task { await model.start() }
    while !model.isLoading { await Task.yield() }
    work.cancel()
    await work.value
    XCTAssertFalse(model.snapshot.hasLoaded)
    await client.setDelay(0)
    await model.start()
    XCTAssertTrue(model.snapshot.hasLoaded)
    XCTAssertEqual(model.items, [item])
  }
}
