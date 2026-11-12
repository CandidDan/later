import LaterKit
import SwiftUI

struct SavedView: View {
  @Environment(NarrationCoordinator.self) private var coordinator

  var body: some View {
    ShellScreen(title: "Saved") {
      if let model = coordinator.model {
        SavedContent(model: model)
      } else if coordinator.configurationFailed {
        ContentUnavailableView(
          "Couldn't open Saved", systemImage: "exclamationmark.triangle",
          description: Text("Please close and reopen Later to try again."))
      } else {
        ProgressView("Opening Saved")
      }
    }
  }
}

private struct SavedContent: View {
  let model: SavedViewModel
  @Environment(\.scenePhase) private var scenePhase
  @State private var selected: LaterKit.LibraryItem?

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        if let notice = model.narrationNotice { Text(notice) }
        if model.isOffline {
          Text(
            model.snapshot.hasLoaded
              ? SavedViewModel.offlineNotice : "You're offline. Connect to load Saved."
          )
          .accessibilityIdentifier("saved.offline")
        }
        if let message = model.message {
          Text(message).accessibilityIdentifier("saved.message")
        }
        if model.pendingCount > 0 {
          Button("Retry saved actions (\(model.pendingCount))") {
            Task { await model.retryPending() }
          }
          .disabled(model.isSending)
        }
        if model.showEmpty {
          Text("Nothing saved yet. Share a link to Later, or send it on WhatsApp or email.")
            .accessibilityIdentifier("saved.empty")
        } else if !model.snapshot.hasLoaded && !model.isLoading {
          Button("Load Saved") { Task { await model.reconnect() } }
            .accessibilityIdentifier("saved.retry")
        }
        ForEach(model.items) { item in
          Button {
            selected = item
          } label: {
            VStack(alignment: .leading, spacing: 8) {
              Text(item.displayTitle).font(.headline)
              Text("\(item.displaySource) · Saved \(item.displayDate)").font(.subheadline)
              Text(model.narration?.statusLabel(for: item) ?? item.statusLabel).font(.subheadline)
              if let reason = model.narration?.reasonLabel(for: item) ?? item.reasonLabel {
                Text(reason).font(.subheadline)
              }
            }
            .foregroundStyle(ColorToken.textPrimary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(ColorToken.surface.color, in: RoundedRectangle(cornerRadius: 16))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(
            [
              item.displayTitle, item.displaySource, "Saved \(item.displayDate)",
              model.narration?.statusLabel(for: item) ?? item.statusLabel,
              model.narration?.reasonLabel(for: item) ?? item.reasonLabel,
            ].compactMap { $0 }.joined(separator: ", ")
          )
          .accessibilityIdentifier("saved.item.\(item.id.uuidString)")
        }
        if model.isLoading { ProgressView("Loading Saved") }
        if model.hasNextPage {
          Button("Load more") { Task { await model.loadNextPage() } }
            .disabled(model.isLoading)
            .accessibilityIdentifier("saved.more")
        }
      }
      .padding()
    }
    .foregroundStyle(ColorToken.textPrimary.color)
    .refreshable {
      await model.refresh()
      Task { await model.narration?.process() }
    }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y > 10
        && geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height
          - 80
    } action: { _, atEnd in
      if atEnd { Task { await model.loadNextPage() } }
    }
    .sheet(item: $selected) { item in SavedDetailView(selected: item, model: model) }
    .task {
      await model.start()
      for await online in SavedConnectivity.updates() {
        if online, scenePhase == .active {
          await model.reconnect()
          Task { await model.narration?.process() }
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task {
          await model.reconnect()
          Task { await model.narration?.process() }
        }
      }
    }
  }
}

private struct SavedDetailView: View {
  let selected: LaterKit.LibraryItem
  let model: SavedViewModel
  private var item: LaterKit.LibraryItem { model.items.first { $0.id == selected.id } ?? selected }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var confirmingDone = false
  @State private var showingPlayer = false
  @Environment(NarrationCoordinator.self) private var coordinator

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(item.displayTitle).font(.title2).accessibilityIdentifier("saved.detail.title")
          if let creator = item.creator, !creator.isEmpty { Text(creator) }
          Text(item.displaySource)
          Text("Saved \(item.displayDate)")
          Text(model.narration?.statusLabel(for: item) ?? item.statusLabel)
          if let reason = model.narration?.reasonLabel(for: item) ?? item.reasonLabel {
            Text(reason)
          }
          if let narration = model.narration, item.listen.state == .narratable {
            Text("Narrated by Later with an iPhone voice · Source: \(item.displaySource)")
            if narration.manifest(for: item) == nil && narration.snapshot.conflicts[item.id] == nil
            {
              Button("Prepare", systemImage: "arrow.down.circle") {
                narration.enqueue(item)
                Task { await narration.process() }
              }
              .disabled(narration.preparing == item.id)
              .accessibilityIdentifier("saved.detail.prepare")
            }
            if let message = narration.message { Text(message) }
          }
          if let message = model.message {
            Text(message).accessibilityIdentifier("saved.detail.message")
          }
          if let message = coordinator.player?.message {
            Text(message).accessibilityIdentifier("saved.detail.player.message")
          }
          if model.narration?.manifest(for: item) != nil, coordinator.player != nil {
            Button("Play", systemImage: "play.fill") {
              showingPlayer = coordinator.startPlayback([item])
            }.accessibilityIdentifier("saved.detail.play")
          }
          Button("Open original", systemImage: "arrow.up.right.square") {
            Task {
              if let destination = await model.perform(.open, on: item) { openURL(destination) }
            }
          }
          .accessibilityIdentifier("saved.detail.open")
          Button("Done with this", systemImage: "checkmark") { confirmingDone = true }
            .accessibilityIdentifier("saved.detail.consume")
        }
        .disabled(model.isSending)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
      }
      .foregroundStyle(ColorToken.textPrimary.color)
      .background(ColorToken.background.color)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Close") { dismiss() }.accessibilityIdentifier("saved.detail.close")
        }
      }
      .navigationDestination(isPresented: $showingPlayer) {
        if let player = coordinator.player { PlayerScreen(engine: player, model: model) }
      }
      .alert("Mark this item done?", isPresented: $confirmingDone) {
        Button("Mark done") { Task { _ = await model.perform(.consume, on: item) } }
        Button("Cancel", role: .cancel) {}
      }
    }
  }
}
