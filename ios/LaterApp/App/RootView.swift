import SwiftUI

struct RootView: View {
  @Environment(AuthService.self) private var auth

  var body: some View {
    Group {
      if auth.isRestoring {
        ProgressView("Opening Later")
      } else if auth.session != nil {
        TabView {
          Tab("Listen", systemImage: "headphones") { ListenView() }
          Tab("Saved", systemImage: "tray.full") {
            SavedView().id(auth.session?.user.id)
          }
        }
      } else {
        SignInView()
      }
    }
    .tint(ColorToken.accent.color)
  }
}
