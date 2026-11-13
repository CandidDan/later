import Foundation
import LaterKit
import XCTest

@testable import Later

final class CaptureFileOutboxTests: XCTestCase, @unchecked Sendable {
  func testSurvivesRecreationAndSeparateWritersDoNotLoseCaptures() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let first = CaptureFileOutbox(parent: parent)
    let second = CaptureFileOutbox(parent: parent)
    let capture = PendingCapture(request: CaptureRequest(text: "First"), ownerID: UUID())
    let another = PendingCapture(request: CaptureRequest(text: "Second"), ownerID: UUID())
    try await first.insert(capture)
    try await second.insert(another)
    try await first.insert(capture)
    let recreated = CaptureFileOutbox(parent: parent)
    let pending = try await recreated.pending()
    XCTAssertEqual(
      Set(pending.map(\.request.requestId)), [capture.request.requestId, another.request.requestId])
    try await second.remove(requestID: capture.request.requestId)
    try await first.remove(requestID: capture.request.requestId)
    let remaining = try await recreated.pending()
    XCTAssertEqual(remaining, [another])
  }

  func testWritesAreAtomicAndProtected() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let outbox = CaptureFileOutbox(parent: parent) { data, url, options in
      XCTAssertTrue(options.contains(.atomic))
      XCTAssertTrue(options.contains(.completeFileProtectionUntilFirstUserAuthentication))
      try data.write(to: url, options: options)
    }
    try await outbox.insert(PendingCapture(request: CaptureRequest(text: "Private"), ownerID: UUID()))
    let pending = try await outbox.pending()
    XCTAssertEqual(pending.count, 1)
  }

  func testWriteFailureIsNotReportedAsSaved() async throws {
    let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: parent) }
    let outbox = CaptureFileOutbox(parent: parent) { _, _, _ in
      throw CocoaError(.fileWriteOutOfSpace)
    }
    do {
      try await outbox.insert(PendingCapture(request: CaptureRequest(text: "Private"), ownerID: nil))
      XCTFail("A failed write must propagate")
    } catch let error as CocoaError {
      XCTAssertEqual(error.code, .fileWriteOutOfSpace)
    }
    let pending = try await outbox.pending()
    XCTAssertTrue(pending.isEmpty)
  }
}
