import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class ListenViewModelTests: XCTestCase {
  func testUsesPlannerWithActualDurations() throws {
    let ready = try [entry(1, duration: 480, position: 95), entry(2, duration: 300)]
    let model = ListenViewModel(read: { ListenSnapshot(ready: ready) }, start: { _ in true })
    model.select(.fifteen)
    XCTAssertEqual(
      model.plan, try TimeFitPlanner.plan(target: .fifteen, candidates: ready.map(\.candidate)))
    XCTAssertEqual(model.plan?.total, 685)
    XCTAssertEqual(model.continuing?.id, ready[0].id)
    let first = model.plan
    model.refresh()
    XCTAssertEqual(model.plan, first)
  }
  func testExcludesUnrenderedItems() throws {
    let ready = try entry(1, duration: 400)
    let unrendered = try entry(2, duration: 800)
    let snapshot = ListenViewModel.makeSnapshot(
      items: [ready.item, unrendered.item], resume: ResumeStore(), pending: [unrendered.id],
      manifest: { item in
        guard item.id == ready.id else { return nil }
        return NarrationManifest(
          captureId: item.id, textVersion: "v1", voiceID: "fixture", directory: UUID(),
          audioFile: "audio.caf", duration: 400, renderedAt: Date())
      })
    let model = ListenViewModel(read: { snapshot }, start: { _ in true })
    model.refresh()
    XCTAssertEqual(model.planned.map(\.id), [ready.id])
    XCTAssertEqual(model.snapshot.preparing, 1)
  }

  func testHonestStates() throws {
    var ready = try [entry(1, duration: 720)]
    let model = ListenViewModel(read: { ListenSnapshot(ready: ready) }, start: { _ in true })
    model.select(.fifteen)
    XCTAssertEqual(model.plan?.summary, "12 min of 15 min — that's everything ready right now")
    ready = []
    model.refresh()
    XCTAssertEqual(model.plan?.summary, "Nothing's ready to listen to yet")
  }
  func testLongerListensAreExplicit() throws {
    let item = try entry(1, duration: 1900)
    var played: [LibraryItem] = []
    let model = ListenViewModel(
      read: { ListenSnapshot(ready: [item]) },
      start: {
        played = $0; return true
      })
    model.select(.ten)
    XCTAssertEqual(model.longer.map(\.id), [item.id])
    XCTAssertEqual(model.longer.first?.duration, 1900)
    XCTAssertTrue(played.isEmpty)
    XCTAssertFalse(model.playPlan())
    XCTAssertTrue(model.playItem(item.id))
    XCTAssertEqual(played.map(\.id), [item.id])
  }
  func testPlayQueuesPlanInOrder() throws {
    let ready = try [entry(1, duration: 480), entry(2, duration: 300)]
    var played: [LibraryItem] = []
    let model = ListenViewModel(
      read: { ListenSnapshot(ready: ready) },
      start: {
        played = $0; return true
      })
    model.select(.fifteen)
    XCTAssertTrue(played.isEmpty)
    XCTAssertTrue(model.playPlan())
    XCTAssertEqual(played.map { $0.id.uuidString }, model.plan?.items.map(\.id))
  }
  func testChangedPreviewRequiresAnotherTapAndReadFailureClearsPlan() throws {
    var ready = try [entry(1, duration: 480)]
    var fail = false
    var starts = 0
    let model = ListenViewModel(
      read: {
        if fail { throw CocoaError(.fileReadUnknown) }
        return ListenSnapshot(ready: ready)
      },
      start: { _ in
        starts += 1; return true
      })
    model.refresh()
    ready = try [entry(2, duration: 300)]
    XCTAssertFalse(model.playPlan())
    XCTAssertEqual(starts, 0)
    XCTAssertNotNil(model.message)
    XCTAssertTrue(model.playPlan())
    fail = true
    model.refresh()
    XCTAssertNil(model.plan)
    XCTAssertTrue(model.planned.isEmpty)
  }
  private func entry(_ n: Int, duration: Double, position: Double = 0) throws -> ReadyListen {
    let data = Data(
      """
      {"captureId":"00000000-0000-4000-8000-00000000000\(n)","title":"Item \(n)","source":"Example","savedAt":"2026-11-12T12:00:00Z","kind":"article","listen":{"state":"narratable","textVersion":"v1","wordCount":50}}
      """.utf8)
    return ReadyListen(
      item: try JSONDecoder().decode(LibraryItem.self, from: data), duration: duration,
      position: position)
  }
}
