import Foundation

public struct ResumePosition: Codable, Equatable, Sendable {
  public let textVersion: String
  public let seconds: TimeInterval
}

public struct ResumeStore: Codable, Equatable, Sendable {
  public private(set) var positions: [UUID: ResumePosition] = [:]
  public init() {}

  public mutating func record(_ item: PlaybackItem, position: TimeInterval) {
    guard position.isFinite, item.duration.isFinite, item.duration > 0 else { return }
    positions[item.id] = ResumePosition(
      textVersion: item.textVersion, seconds: min(item.duration, max(0, position)))
  }

  public func startPosition(for item: PlaybackItem) -> TimeInterval {
    guard let saved = positions[item.id], saved.textVersion == item.textVersion,
      saved.seconds.isFinite, item.duration.isFinite, item.duration > 0,
      saved.seconds >= 0, saved.seconds < item.duration - 10
    else { return 0 }
    return max(0, saved.seconds - 5)
  }
}
