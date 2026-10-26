import SwiftUI

/// The two tabs of v1. Neither is connected to an account in this build, and each says so.
struct RootView: View {
  var body: some View {
    TabView {
      Tab("Listen", systemImage: "headphones") {
        ListenView()
      }
      Tab("Saved", systemImage: "tray.full") {
        SavedView()
      }
    }
    .tint(ColorToken.accent.color)
  }
}
