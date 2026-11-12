import LaterKit
import SwiftUI

struct MiniPlayer: View {
  let engine: PlayerEngine
  let open: () -> Void
  var body: some View {
    HStack(spacing: 16) {
      Button(action: open) {
        VStack(alignment: .leading, spacing: 4) {
          Text(engine.current?.title ?? "Later").font(.headline).lineLimit(1)
          Text(engine.isPlaying ? "Playing" : "Paused").font(.caption)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.accessibilityIdentifier("player.mini.open")
      Button(
        engine.isPlaying ? "Pause" : "Play",
        systemImage: engine.isPlaying ? "pause.fill" : "play.fill"
      ) {
        engine.handle(.toggle)
      }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        .accessibilityIdentifier("player.mini.toggle")
    }
    .foregroundStyle(ColorToken.textPrimary.color)
    .padding(.horizontal).padding(.vertical, 8)
    .background(ColorToken.surfaceRaised.color)
  }
}

struct PlayerScreen: View {
  let engine: PlayerEngine
  let model: SavedViewModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var scrubPosition: Double?
  @State private var confirmingDone = false
  @State private var doneCaptureID: UUID?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let item = engine.current {
          VStack(alignment: .leading, spacing: 8) {
            Text(item.title).font(.title2).accessibilityIdentifier("player.title")
            Text(item.source).font(.subheadline)
            Text("Narrated by Later with an iPhone voice").font(.caption)
          }
          VStack(spacing: 8) {
            Slider(
              value: Binding(
                get: { scrubPosition ?? engine.position }, set: { scrubPosition = $0 }),
              in: 0...max(1, item.duration),
              onEditingChanged: { editing in
                if !editing, let position = scrubPosition {
                  engine.seek(position); scrubPosition = nil
                }
              }
            )
            .accessibilityLabel("Playback position").accessibilityIdentifier("player.scrubber")
            HStack {
              Text(Self.clock(scrubPosition ?? engine.position))
              Spacer()
              Text(
                "−\(Self.clock(max(0, item.duration - (scrubPosition ?? engine.position)) / engine.speed)) at \(speedLabel)"
              )
            }.font(.caption).monospacedDigit()
          }
          HStack {
            control("Previous", icon: "backward.end.fill", command: .previous)
            Spacer()
            control("Back 15 seconds", icon: "gobackward.15", command: .back)
            Spacer()
            control(
              engine.isPlaying ? "Pause" : "Play",
              icon: engine.isPlaying ? "pause.fill" : "play.fill", command: .toggle
            )
            .accessibilityIdentifier("player.toggle")
            Spacer()
            control("Forward 30 seconds", icon: "goforward.30", command: .forward)
            Spacer()
            control("Next", icon: "forward.end.fill", command: .next)
          }.font(.title2)
          Menu {
            ForEach(PlayerEngine.speeds, id: \.self) { speed in
              Button("\(speed.formatted())×") { engine.setSpeed(speed) }
            }
          } label: {
            Label("Speed \(speedLabel)", systemImage: "speedometer")
          }
          .accessibilityIdentifier("player.speed")
          VStack(alignment: .leading, spacing: 12) {
            Text("Queue").font(.headline)
            Text("\(Self.clock(engine.remaining)) remaining at \(speedLabel)")
              .accessibilityIdentifier("player.remaining")
            ForEach(Array((engine.queue?.items ?? []).enumerated()), id: \.element.id) {
              index, queued in
              HStack(alignment: .top) {
                if index == engine.queue?.index { Image(systemName: "speaker.wave.2") }
                VStack(alignment: .leading) {
                  Text(queued.title); Text(queued.source).font(.caption)
                }
              }
            }
          }.accessibilityIdentifier("player.queue")
          if let message = engine.message { Text(message) }
          if let message = model.message {
            Text(message).accessibilityIdentifier("player.action.message")
          }
          Button("Open original", systemImage: "arrow.up.right.square") {
            Task { if let url = await model.perform(.open, captureID: item.id) { openURL(url) } }
          }.disabled(model.isSending).accessibilityIdentifier("player.open")
          Button("Done with this", systemImage: "checkmark") {
            doneCaptureID = item.id
            confirmingDone = true
          }
          .disabled(model.isSending).accessibilityIdentifier("player.consume")
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
    }
    .foregroundStyle(ColorToken.textPrimary.color)
    .background(ColorToken.background.color)
    .navigationTitle("Now playing").navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
    .onChange(of: engine.current?.id) { scrubPosition = nil }
    .alert("Mark this item done?", isPresented: $confirmingDone) {
      Button("Mark done") {
        if let captureID = doneCaptureID {
          Task { _ = await model.perform(.consume, captureID: captureID) }
        }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  private var speedLabel: String { "\(engine.speed.formatted())×" }
  private func control(_ title: String, icon: String, command: PlayerCommand) -> some View {
    Button(title, systemImage: icon) { engine.handle(command) }
      .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
  }
  private static func clock(_ seconds: Double) -> String {
    let value = Int(max(0, seconds.isFinite ? seconds : 0))
    return value >= 3_600
      ? String(format: "%d:%02d:%02d", value / 3_600, value / 60 % 60, value % 60)
      : String(format: "%d:%02d", value / 60, value % 60)
  }
}
