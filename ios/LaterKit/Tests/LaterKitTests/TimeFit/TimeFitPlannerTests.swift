import Foundation
import XCTest

@testable import LaterKit

final class TimeFitPlannerTests: XCTestCase {
  func testNeverOverrunsAndMaximisesFill() throws {
    var random = SeededRandom()
    for iteration in 0..<120 {
      let slot = ListenSlot.allCases[iteration % ListenSlot.allCases.count]
      let candidates = (0..<(iteration % 12 + 1)).map { index in
        let remaining = Double(random.next(10000) + 1) / 4
        let position = Double(random.next(200)) / 4
        return candidate("\(index)", remaining + position, position: position)
      }
      let plan = try TimeFitPlanner.plan(target: slot, candidates: candidates)
      XCTAssertLessThanOrEqual(plan.total, slot.duration)
      XCTAssertEqual(plan.total, oracleTotal(slot, candidates), "Iteration \(iteration)")
      XCTAssertEqual(plan.total, plan.items.reduce(0) { $0 + $1.remaining })
      XCTAssertEqual(plan.shortfall, slot.duration - plan.total)
      XCTAssertEqual(Set(plan.items.map(\.id)).count, plan.items.count)
    }
  }

  func testFractionalBudgetsAreConservativeAndOutputRemainsActual() throws {
    // Actual 599.4 fits, but the reservations 301 + 300 do not. No exponential fractional search.
    let inputs = [candidate("a", 300.2), candidate("b", 299.2), candidate("c", 599.3)]
    let plan = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
    XCTAssertEqual(plan.items.map(\.id), ["c"])
    XCTAssertEqual(plan.total, 599.3)
    XCTAssertEqual(plan.items.first?.remaining, 599.3)
    XCTAssertEqual(plan.total, oracleTotal(.ten, inputs))
  }

  func testMaximisesActualDurationNotRoundedBudget() throws {
    let inputs = [candidate("older", 599.1), candidate("longer", 599.9, savedAt: 2)]
    let plan = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
    XCTAssertEqual(plan.items.map(\.id), ["longer"])
    XCTAssertEqual(plan.total, 599.9)
  }

  func testInProgressUsesRemainingAndLeads() throws {
    let plan = try TimeFitPlanner.plan(
      target: .ten,
      candidates: [candidate("old", 200, savedAt: 0), candidate("resume", 900.5, position: 500.5)])
    XCTAssertEqual(plan.items.map(\.id), ["resume", "old"])
    XCTAssertEqual(plan.items.first?.remaining, 400)
    XCTAssertEqual(plan.total, 600)
    XCTAssertEqual(plan.fill, .full)
  }

  func testInProgressWinsOnlyEqualDurationTies() throws {
    let resume = candidate("resume", 700, position: 100, savedAt: 3)
    let full = try TimeFitPlanner.plan(target: .ten, candidates: [candidate("old", 600), resume])
    XCTAssertEqual(full.items.map(\.id), ["resume"])
    let longer = try TimeFitPlanner.plan(
      target: .ten, candidates: [candidate("old", 600), candidate("partial", 501, position: 1)])
    XCTAssertEqual(longer.items.map(\.id), ["old"])
  }

  func testHonestUnderfill() throws {
    let plan = try TimeFitPlanner.plan(
      target: .fifteen, candidates: [candidate("a", 400.5), candidate("b", 350.25)])
    XCTAssertEqual(plan.items.map(\.id), ["a", "b"])
    XCTAssertEqual(plan.total, 750.75)
    XCTAssertEqual(plan.fill, .under(.notEnoughReady))
    XCTAssertEqual(plan.summary, "12 min of 15 min — that's everything ready right now")
  }

  func testHonestCombinationUnderfill() throws {
    let plan = try TimeFitPlanner.plan(
      target: .ten, candidates: [candidate("a", 400), candidate("b", 400)])
    XCTAssertEqual(plan.total, 400)
    XCTAssertEqual(plan.fill, .under(.noCombinationFits))
    XCTAssertEqual(plan.summary, "6 min of 10 min — more is ready, but won't fit this slot")
  }

  func testEmpty() throws {
    let plan = try TimeFitPlanner.plan(target: .fifteen, candidates: [])
    XCTAssertEqual(plan.items, [])
    XCTAssertEqual(plan.tooLong, [])
    XCTAssertEqual(plan.total, 0)
    XCTAssertEqual(plan.shortfall, 900)
    XCTAssertEqual(plan.fill, .empty(.nothingReady))
    XCTAssertEqual(plan.summary, "Nothing's ready to listen to yet")
  }

  func testTooLongIsOfferedNotIncluded() throws {
    let long = candidate("long", 1000, position: 300)
    let plan = try TimeFitPlanner.plan(target: .ten, candidates: [long, candidate("short", 300)])
    XCTAssertEqual(plan.items.map(\.id), ["short"])
    XCTAssertEqual(plan.tooLong, [long])
    XCTAssertEqual(plan.fill, .under(.notEnoughReady))
    XCTAssertEqual(plan.summary, "5 min of 10 min — that's everything that fits right now")
  }

  func testOnlyLongerListens() throws {
    let inputs = [candidate("b", .greatestFiniteMagnitude), candidate("a", 600.01)]
    let plan = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
    XCTAssertEqual(plan.items, [])
    XCTAssertEqual(plan.fill, .empty(.noCombinationFits))
    XCTAssertEqual(plan.tooLong.map(\.id), ["a", "b"])
    XCTAssertEqual(plan.summary, "Nothing ready fits this slot — try a longer listen")
  }

  func testDeterministic() throws {
    let inputs = [
      candidate("z", 300, savedAt: 0), candidate("a", 300, savedAt: 0),
      candidate("resume-b", 400, position: 100, savedAt: 3),
      candidate("resume-a", 400, position: 100, savedAt: 2),
      candidate("long", 900),
    ]
    let expected = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
    XCTAssertEqual(expected.items.map(\.id), ["resume-a", "resume-b"])
    for order in permutations(inputs) {
      XCTAssertEqual(try TimeFitPlanner.plan(target: .ten, candidates: order), expected)
    }
  }

  func testOlderSavesThenIDBreakTiesAcrossCombinations() throws {
    let inputs = [
      candidate("a", 400, savedAt: 0), candidate("b", 600, savedAt: 1),
      candidate("z", 200, savedAt: 2), candidate("c", 200, savedAt: 2),
    ]
    let plan = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
    XCTAssertEqual(plan.items.map(\.id), ["a", "c"])
  }

  func testFullBoundaryAndRoundedDownTotals() throws {
    let full = try TimeFitPlanner.plan(target: .ten, candidates: [candidate("a", 540)])
    XCTAssertEqual(full.fill, .full)
    XCTAssertEqual(full.summary, "9 min of 10 min — ready to listen")
    let under = try TimeFitPlanner.plan(target: .ten, candidates: [candidate("a", 539.99)])
    XCTAssertEqual(under.fill, .under(.notEnoughReady))
    XCTAssertEqual(under.summary, "8 min of 10 min — that's everything ready right now")
    let tiny = try TimeFitPlanner.plan(target: .thirty, candidates: [candidate("a", 0.25)])
    XCTAssertEqual(tiny.total, 0.25)
    XCTAssertEqual(tiny.summary, "0 min of 30 min — that's everything ready right now")
  }

  func testRejectsInvalidCandidates() throws {
    for duration in [0.0, -1, .nan, .infinity, -.infinity] {
      assertRejected(candidate("bad", duration), reason: .invalidDuration)
    }
    for position in [-1.0, 600, 601, .nan, .infinity, -.infinity] {
      assertRejected(candidate("bad", 600, position: position), reason: .invalidPosition)
    }
    assertRejected(candidate("bad", 600, savedAt: .nan), reason: .invalidSavedAt)
    XCTAssertThrowsError(
      try TimeFitPlanner.plan(target: .ten, candidates: [candidate("a", 1), candidate("a", 2)])
    ) { error in
      XCTAssertEqual(error as? TimeFitPlanningError, .duplicateID("a"))
    }
  }

  func testTwoHundredCandidateBound() throws {
    let inputs = (0..<200).map { candidate(String(format: "%03d", $0), 1.25) }
    let plan = try TimeFitPlanner.plan(target: .thirty, candidates: inputs.reversed())
    XCTAssertEqual(plan.items.map(\.id), inputs.map(\.id))
    XCTAssertEqual(plan.total, 250)
    XCTAssertThrowsError(
      try TimeFitPlanner.plan(target: .thirty, candidates: inputs + [candidate("extra", 1)])
    ) { error in
      XCTAssertEqual(error as? TimeFitPlanningError, .tooManyCandidates(maximum: 200))
    }
  }

  func testTieBreakingAcrossAllSelectionWords() throws {
    for prefixCount in [64, 128, 192] {
      let prefix = (0..<prefixCount).map { candidate(String(format: "%03d", $0), 1) }
      let inputs =
        prefix + [
          candidate("tail-a", Double(600 - prefixCount), savedAt: 2),
          candidate("tail-b", Double(600 - prefixCount), savedAt: 2),
        ]
      let plan = try TimeFitPlanner.plan(target: .ten, candidates: inputs)
      XCTAssertEqual(plan.total, 600)
      XCTAssertEqual(plan.items.map(\.id), prefix.map(\.id) + ["tail-a"])
    }
  }

  private func candidate(
    _ id: String, _ duration: TimeInterval, position: TimeInterval = 0, savedAt: TimeInterval = 1
  ) -> ListenCandidate {
    ListenCandidate(
      id: id, savedAt: Date(timeIntervalSince1970: savedAt), audioDuration: duration,
      position: position)
  }

  private func assertRejected(
    _ input: ListenCandidate, reason: TimeFitPlanningError.InvalidCandidateReason,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertThrowsError(
      try TimeFitPlanner.plan(target: .ten, candidates: [input]), file: file, line: line
    ) { error in
      XCTAssertEqual(
        error as? TimeFitPlanningError, .invalidCandidate(id: input.id, reason: reason),
        file: file, line: line)
    }
  }

  private func oracleTotal(_ slot: ListenSlot, _ candidates: [ListenCandidate]) -> TimeInterval {
    var best: TimeInterval = 0
    for mask in 0..<(1 << candidates.count) {
      var total: TimeInterval = 0
      var budget: TimeInterval = 0
      for (index, item) in candidates.enumerated() where mask & (1 << index) != 0 {
        total += item.remaining
        budget += item.remaining.rounded(.up)
      }
      if budget <= slot.duration { best = max(best, total) }
    }
    return best
  }

  private func permutations(_ values: [ListenCandidate]) -> [[ListenCandidate]] {
    guard values.count > 1 else { return [values] }
    return values.indices.flatMap { index in
      var rest = values
      let first = rest.remove(at: index)
      return permutations(rest).map { [first] + $0 }
    }
  }

  private struct SeededRandom {
    var state: UInt64 = 20261112

    mutating func next(_ maximum: UInt64) -> UInt64 {
      state = state &* 6_364_136_223_846_793_005 &+ 1
      return (state >> 32) % maximum
    }
  }
}
