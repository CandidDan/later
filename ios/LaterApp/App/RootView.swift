import SwiftUI

struct RootView: View {
  @Environment(AuthService.self) private var auth
  @Environment(NarrationCoordinator.self) private var coordinator

  var body: some View {
    Group {
      if auth.isRestoring {
        ProgressView("Opening Later")
      } else if auth.session != nil {
        TabView {
          Tab("Listen", systemImage: "headphones") {
            ListenView().safeAreaInset(edge: .bottom) { miniPlayer }
          }
          Tab("Saved", systemImage: "tray.full") {
            SavedView().id(auth.session?.user.id).safeAreaInset(edge: .bottom) { miniPlayer }
          }
        }
      } else {
        SignInView()
      }
    }
    .tint(ColorToken.accent.color)
    .sheet(
      isPresented: Binding(
        get: { coordinator.showingPlayer }, set: { coordinator.showingPlayer = $0 })
    ) {
      if let player = coordinator.player, let model = coordinator.model {
        NavigationStack { PlayerScreen(engine: player, model: model) }
      }
    }
  }

  @ViewBuilder
  private var miniPlayer: some View {
    if let player = coordinator.player, player.current != nil {
      MiniPlayer(engine: player) { coordinator.showingPlayer = true }
    }
  }
}
