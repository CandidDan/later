import Foundation
import LaterKit
import MediaPlayer

/// All entry points, including headphone commands, use the engine's same command handler.
enum PlayerCommand: Equatable, Sendable {
  case play, pause, toggle, forward, back, next, previous
  case seek(TimeInterval)
}

struct PlayerNowPlaying: Equatable {
  let item: PlaybackItem
  let position: TimeInterval
  let rate: Double
}

@MainActor
protocol PlayerRemoteControlling: AnyObject {
  var onCommand: ((PlayerCommand) -> Void)? { get set }
  func update(_ value: PlayerNowPlaying?)
  func clear()
}

@MainActor
final class PlayerRemoteControls: PlayerRemoteControlling {
  var onCommand: ((PlayerCommand) -> Void)?
  private let center: MPRemoteCommandCenter
  private var targets: [(MPRemoteCommand, Any)] = []

  init(center: MPRemoteCommandCenter = .shared()) {
    self.center = center
    bind(center.playCommand, to: .play)
    bind(center.pauseCommand, to: .pause)
    bind(center.togglePlayPauseCommand, to: .toggle)
    bind(center.skipForwardCommand, to: .forward)
    bind(center.skipBackwardCommand, to: .back)
    bind(center.nextTrackCommand, to: .next)
    bind(center.previousTrackCommand, to: .previous)
    center.skipForwardCommand.preferredIntervals = [30]
    center.skipBackwardCommand.preferredIntervals = [15]
    let command = center.changePlaybackPositionCommand
    let token = command.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent, event.positionTime.isFinite
      else {
        return .commandFailed
      }
      let seconds = event.positionTime
      Task { @MainActor in self?.dispatch(.seek(seconds)) }
      return .success
    }
    targets.append((command, token))
    update(nil)
  }

  private func bind(_ remote: MPRemoteCommand, to command: PlayerCommand) {
    let token = remote.addTarget { [weak self] _ in
      Task { @MainActor in self?.dispatch(command) }
      return .success
    }
    targets.append((remote, token))
  }

  func dispatch(_ command: PlayerCommand) { onCommand?(command) }

  func update(_ value: PlayerNowPlaying?) {
    for (command, _) in targets { command.isEnabled = value != nil }
    guard let value else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: value.item.title,
      MPMediaItemPropertyArtist: value.item.source,
      MPMediaItemPropertyAlbumTitle: "Later",
      MPMediaItemPropertyPlaybackDuration: value.item.duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: value.position,
      MPNowPlayingInfoPropertyPlaybackRate: value.rate,
    ]
  }

  func clear() {
    update(nil)
    for (command, token) in targets { command.removeTarget(token) }
    targets.removeAll()
    onCommand = nil
  }
}
