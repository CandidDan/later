import Foundation

/// Formats a listening length the way Later shows it: whole minutes, rounded up, so a 9½-minute
/// narration never claims to fit a 9-minute slot.
public enum ListeningDuration {
  /// The slots Listen offers: 10, 15 and 30 minutes.
  public static let slots: [Duration] = [.seconds(10 * 60), .seconds(15 * 60), .seconds(30 * 60)]

  /// "1 min", "15 min", "1 hr", "1 hr 5 min". Negative durations format as "0 min".
  public static func format(_ duration: Duration) -> String {
    let seconds = max(0, duration.components.seconds)
    let hasFraction = duration.components.attoseconds > 0
    let totalMinutes = Int((seconds + 59) / 60) + (hasFraction && seconds % 60 == 0 ? 1 : 0)
    let hours = totalMinutes / 60
    let minutes = totalMinutes % 60
    switch (hours, minutes) {
    case (0, _): return "\(minutes) min"
    case (_, 0): return "\(hours) hr"
    default: return "\(hours) hr \(minutes) min"
    }
  }

  /// "10 min, 15 min or 30 min".
  public static func list(_ durations: [Duration]) -> String {
    let parts = durations.map(format)
    guard let last = parts.last else { return "" }
    guard parts.count > 1 else { return last }
    return parts.dropLast().joined(separator: ", ") + " or " + last
  }
}
