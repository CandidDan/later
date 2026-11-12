import Foundation

public struct PlaybackItem: Codable, Equatable, Sendable, Identifiable {
  public var id: UUID { captureId }
  public let captureId: UUID
  public let textVersion: String
  public let title: String
  public let source: String
  public let duration: TimeInterval
  public var startPosition: TimeInterval

  public init(
    captureId: UUID, textVersion: String, title: String, source: String,
    duration: TimeInterval, startPosition: TimeInterval = 0
  ) {
    self.captureId = captureId
    self.textVersion = textVersion
    self.title = title
    self.source = source
    self.duration = duration
    self.startPosition = startPosition
  }
}

public enum PlaybackQueueError: Error, Equatable { case invalidItem, duplicateItem }

/// Seeking/skipping stays in the current item. Next advances, including ending the last item.
/// Previous restarts after three seconds; otherwise it moves back and starts that item at zero.
public struct PlaybackQueue: Equatable, Sendable {
  public private(set) var items: [PlaybackItem]
  public private(set) var index: Int = 0
  public private(set) var position: TimeInterval = 0
  public private(set) var isFinished = false
  public var current: PlaybackItem? { items.indices.contains(index) ? items[index] : nil }
  public var hasNext: Bool { index + 1 < items.count }
  public var hasPrevious: Bool { index > 0 || position > 0 }

  public init(items: [PlaybackItem] = []) throws {
    var seen: Set<UUID> = []
    for item in items {
      guard item.duration.isFinite, item.duration > 0, !item.textVersion.isEmpty,
        item.startPosition.isFinite, (0...item.duration).contains(item.startPosition)
      else { throw PlaybackQueueError.invalidItem }
      guard seen.insert(item.id).inserted else { throw PlaybackQueueError.duplicateItem }
    }
    self.items = items
    position = items.first?.startPosition ?? 0
  }

  public mutating func seek(to value: TimeInterval) {
    guard value.isFinite, let current else { return }
    position = min(current.duration, max(0, value))
    isFinished = false
  }

  public mutating func skip(_ seconds: TimeInterval) {
    guard seconds.isFinite else { return }
    seek(to: position + seconds)
  }

  @discardableResult
  public mutating func advance() -> Bool {
    guard let current else { return false }
    guard hasNext else { position = current.duration; isFinished = true; return false }
    index += 1
    position = items[index].startPosition
    isFinished = false
    return true
  }

  public mutating func previous() {
    guard current != nil else { return }
    if position <= 3 && index > 0 { index -= 1 }
    position = 0
    isFinished = false
  }

  public func remaining(at speed: Double = 1) -> TimeInterval {
    guard let current, speed.isFinite, speed > 0 else { return 0 }
    let later = items.dropFirst(index + 1).reduce(0) { $0 + $1.duration - $1.startPosition }
    return (max(0, current.duration - position) + later) / speed
  }
}
