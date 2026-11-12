import Foundation

public enum ListenSlot: Int, CaseIterable, Sendable {
  case ten = 600
  case fifteen = 900
  case thirty = 1800

  public var duration: TimeInterval { TimeInterval(rawValue) }
}

/// A fully rendered local recording. The caller is responsible for readiness, never estimates.
public struct ListenCandidate: Equatable, Sendable {
  public let id: String
  public let savedAt: Date
  public let audioDuration: TimeInterval
  public let position: TimeInterval

  public init(id: String, savedAt: Date, audioDuration: TimeInterval, position: TimeInterval = 0) {
    self.id = id
    self.savedAt = savedAt
    self.audioDuration = audioDuration
    self.position = position
  }

  public var remaining: TimeInterval { audioDuration - position }
}

public struct PlannedItem: Equatable, Sendable {
  public let id: String
  public let remaining: TimeInterval
}

public enum ListenPlanReason: Equatable, Sendable {
  case notEnoughReady
  case nothingReady
  case noCombinationFits
}

public enum ListenPlanFill: Equatable, Sendable {
  case full
  case under(ListenPlanReason)
  case empty(ListenPlanReason)
}

public struct ListenPlan: Equatable, Sendable {
  public let items: [PlannedItem]
  public let total: TimeInterval
  public let target: TimeInterval
  public let fill: ListenPlanFill
  public let tooLong: [ListenCandidate]

  public var shortfall: TimeInterval { target - total }

  /// Totals are rounded down before using Later's shared duration formatter.
  public var summary: String {
    if items.isEmpty {
      return tooLong.isEmpty
        ? "Nothing's ready to listen to yet"
        : "Nothing ready fits this slot — try a longer listen"
    }
    let actual = ListeningDuration.format(.seconds(Int64(total / 60) * 60))
    let slot = ListeningDuration.format(.seconds(Int64(target)))
    let amount = "\(actual) of \(slot)"
    switch fill {
    case .full:
      return "\(amount) — ready to listen"
    case .under(.notEnoughReady):
      return tooLong.isEmpty
        ? "\(amount) — that's everything ready right now"
        : "\(amount) — that's everything that fits right now"
    default:
      return "\(amount) — more is ready, but won't fit this slot"
    }
  }
}

public enum TimeFitPlanningError: Error, Equatable, Sendable {
  case tooManyCandidates(maximum: Int)
  case invalidCandidate(id: String, reason: InvalidCandidateReason)
  case duplicateID(String)

  public enum InvalidCandidateReason: Equatable, Sendable {
    case invalidDuration
    case invalidPosition
    case invalidSavedAt
  }
}
