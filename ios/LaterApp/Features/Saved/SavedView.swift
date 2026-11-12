import LaterKit
import SwiftUI

struct SavedView: View {
  @Environment(AuthService.self) private var auth
  @State private var model: SavedViewModel?
  @State private var configurationFailed = false

  var body: some View {
    ShellScreen(title: "Saved") {
      if let model {
        SavedContent(model: model)
      } else if configurationFailed {
        ContentUnavailableView(
          "Couldn't open Saved", systemImage: "exclamationmark.triangle",
          description: Text("Please close and reopen Later to try again."))
      } else {
        ProgressView("Opening Saved")
      }
    }
    .task {
      guard model == nil else { return }
      do { model = try SavedServiceFactory.make(auth: auth) } catch {
        configurationFailed = true
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
              Text(item.statusLabel).font(.subheadline)
              if let reason = item.reasonLabel { Text(reason).font(.subheadline) }
            }
            .foregroundStyle(ColorToken.textPrimary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(ColorToken.surface.color, in: RoundedRectangle(cornerRadius: 16))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(item.accessibilitySummary)
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
    .refreshable { await model.refresh() }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y > 10
        && geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height
          - 80
    } action: { _, atEnd in
      if atEnd { Task { await model.loadNextPage() } }
    }
    .sheet(item: $selected) { item in SavedDetailView(item: item, model: model) }
    .task {
      await model.start()
      for await online in SavedConnectivity.updates() {
        if online, scenePhase == .active { await model.reconnect() }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await model.reconnect() } }
    }
  }
}

private struct SavedDetailView: View {
  let item: LaterKit.LibraryItem
  let model: SavedViewModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var confirmingDone = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(item.displayTitle).font(.title2).accessibilityIdentifier("saved.detail.title")
          if let creator = item.creator, !creator.isEmpty { Text(creator) }
          Text(item.displaySource)
          Text("Saved \(item.displayDate)")
          Text(item.statusLabel)
          if let reason = item.reasonLabel { Text(reason) }
          if let message = model.message {
            Text(message).accessibilityIdentifier("saved.detail.message")
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
      .confirmationDialog(
        "Mark this item done?", isPresented: $confirmingDone, titleVisibility: .visible
      ) {
        Button("Mark done") { Task { _ = await model.perform(.consume, on: item) } }
        Button("Cancel", role: .cancel) {}
      }
    }
  }
}
