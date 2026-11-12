import Foundation
import LaterKit

@testable import Later

enum SavedFixtures {
  static func item(
    state: String = "narratable", reason: String? = nil, kind: String = "article",
    title: String? = "A quiet morning", id: UUID = UUID(), date: String = "2026-11-12T12:00:00Z"
  ) throws -> LibraryItem {
    var listen: [String: Any] = ["state": state]
    if let reason { listen["reason"] = reason }
    let data = try JSONSerialization.data(withJSONObject: [
      "captureId": id.uuidString, "title": title as Any? ?? NSNull(), "source": "Example",
      "creator": "Sam", "sourceUrl": "https://example.org/original", "savedAt": date,
      "kind": kind, "listen": listen,
    ])
    return try JSONDecoder().decode(LibraryItem.self, from: data)
  }

  static func page(_ items: [LibraryItem] = [], cursor: String? = nil) throws -> Data {
    struct Page: Encodable {
      let items: [LibraryItem]
      let nextCursor: String?
    }
    return try JSONEncoder().encode(Page(items: items, nextCursor: cursor))
  }
}

actor SavedAPIStub: LaterAPIClient {
  var requests: [LaterAPIRequest] = []
  var firstPage = Data(#"{"items":[],"nextCursor":null}"#.utf8)
  var nextPage = Data(#"{"items":[],"nextCursor":null}"#.utf8)
  var failure: (any Error)?
  var delay: UInt64 = 0
  var actionResponse = Data(
    #"{"status":"applied","destination":"https://example.org/returned"}"#.utf8)

  func setPages(first: Data, next: Data? = nil) {
    firstPage = first
    if let next { nextPage = next }
  }
  func setFailure(_ error: (any Error)?) { failure = error }
  func setDelay(_ nanoseconds: UInt64) { delay = nanoseconds }
  func send(_ request: LaterAPIRequest) async throws -> Data {
    requests.append(request)
    if delay > 0 { try await Task.sleep(nanoseconds: delay) }
    if let failure { throw failure }
    if request.method == .post { return actionResponse }
    return request.query.contains { $0.name == "before" } ? nextPage : firstPage
  }
}

@MainActor
final class SavedMemoryCache: SavedCaching {
  var value: SavedSnapshot?
  var failRead = false
  var failWrite = false
  var writes = 0
  func read() throws -> SavedSnapshot? {
    if failRead { throw CocoaError(.fileReadNoPermission) }
    return value
  }
  func write(_ snapshot: SavedSnapshot) throws {
    if failWrite { throw CocoaError(.fileWriteNoPermission) }
    writes += 1
    value = snapshot
  }
}
