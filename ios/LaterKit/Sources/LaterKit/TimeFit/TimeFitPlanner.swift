import Foundation

/// A bounded planner for up to 200 recordings and slots no longer than 1800 seconds.
///
/// Each item reserves `ceil(remaining)` whole seconds: less than one extra second per item.
/// Dynamic programming maximises the ACTUAL total among subsets that fit those reservations,
/// not among all fractional-duration subsets. Output durations are never rounded or trimmed.
/// There are at most 200 × 1801 transitions, 1801 stored choices and four UInt64 selection words
/// per choice. This avoids an exponential search over arbitrary fractional durations.
public enum TimeFitPlanner {
  public static let maximumCandidateCount = 200

  /// Invalid inputs reject the entire request with a reason, rather than silently losing audio.
  /// Maximum duration wins first; equal totals prefer in-progress items, then older saves, then ID.
  /// The same ordering puts in-progress recordings first in the returned queue.
  public static func plan(target: ListenSlot, candidates: [ListenCandidate]) throws -> ListenPlan {
    try validate(candidates)
    let ordered = candidates.sorted(by: comesFirst)
    let fitting = ordered.filter { $0.remaining <= target.duration }
    let tooLong = ordered.filter { $0.remaining > target.duration }
    var choices = [Choice?](repeating: nil, count: target.rawValue + 1)
    choices[0] = Choice(total: 0, selection: Selection())

    for (index, candidate) in fitting.enumerated() {
      let cost = Int(candidate.remaining.rounded(.up))
      // Descending budgets ensure a candidate is used only once.
      for budget in stride(from: target.rawValue, through: cost, by: -1) {
        guard let previous = choices[budget - cost] else { continue }
        let next = Choice(
          total: previous.total + candidate.remaining,
          selection: previous.selection.including(index))
        if next.isPreferred(to: choices[budget]) { choices[budget] = next }
      }
    }

    var best = Choice(total: 0, selection: Selection())
    for choice in choices.compactMap({ $0 }) where choice.isPreferred(to: best) {
      best = choice
    }
    let items = fitting.enumerated().compactMap { index, candidate -> PlannedItem? in
      guard best.selection.contains(index) else { return nil }
      return PlannedItem(id: candidate.id, remaining: candidate.remaining)
    }
    let fill: ListenPlanFill
    if items.isEmpty {
      fill = .empty(candidates.isEmpty ? .nothingReady : .noCombinationFits)
    } else if target.duration - best.total <= 60 {
      fill = .full
    } else {
      fill = .under(items.count == fitting.count ? .notEnoughReady : .noCombinationFits)
    }
    return ListenPlan(
      items: items, total: best.total, target: target.duration, fill: fill, tooLong: tooLong)
  }

  private static func validate(_ candidates: [ListenCandidate]) throws {
    guard candidates.count <= maximumCandidateCount else {
      throw TimeFitPlanningError.tooManyCandidates(maximum: maximumCandidateCount)
    }
    var ids = Set<String>()
    for candidate in candidates {
      guard candidate.audioDuration.isFinite, candidate.audioDuration > 0 else {
        throw TimeFitPlanningError.invalidCandidate(id: candidate.id, reason: .invalidDuration)
      }
      guard candidate.position.isFinite, candidate.position >= 0,
        candidate.position < candidate.audioDuration
      else {
        throw TimeFitPlanningError.invalidCandidate(id: candidate.id, reason: .invalidPosition)
      }
      guard candidate.savedAt.timeIntervalSinceReferenceDate.isFinite else {
        throw TimeFitPlanningError.invalidCandidate(id: candidate.id, reason: .invalidSavedAt)
      }
      guard ids.insert(candidate.id).inserted else {
        throw TimeFitPlanningError.duplicateID(candidate.id)
      }
    }
  }

  private static func comesFirst(_ lhs: ListenCandidate, _ rhs: ListenCandidate) -> Bool {
    if (lhs.position > 0) != (rhs.position > 0) { return lhs.position > 0 }
    if lhs.savedAt != rhs.savedAt { return lhs.savedAt < rhs.savedAt }
    return lhs.id < rhs.id
  }

  private struct Choice {
    let total: TimeInterval
    let selection: Selection

    func isPreferred(to other: Choice?) -> Bool {
      guard let other else { return true }
      if total != other.total { return total > other.total }
      return selection.isPreferred(to: other.selection)
    }
  }

  /// Fixed-size bitset: earlier candidates have higher bits, so integer comparison breaks ties.
  private struct Selection {
    var first: UInt64 = 0
    var second: UInt64 = 0
    var third: UInt64 = 0
    var fourth: UInt64 = 0

    func including(_ index: Int) -> Selection {
      var copy = self
      let bit = UInt64(1) << (63 - index % 64)
      switch index / 64 {
      case 0: copy.first |= bit
      case 1: copy.second |= bit
      case 2: copy.third |= bit
      default: copy.fourth |= bit
      }
      return copy
    }

    func contains(_ index: Int) -> Bool {
      let word: UInt64
      switch index / 64 {
      case 0: word = first
      case 1: word = second
      case 2: word = third
      default: word = fourth
      }
      return word & (UInt64(1) << (63 - index % 64)) != 0
    }

    func isPreferred(to other: Selection) -> Bool {
      if first != other.first { return first > other.first }
      if second != other.second { return second > other.second }
      if third != other.third { return third > other.third }
      return fourth > other.fourth
    }
  }
}
