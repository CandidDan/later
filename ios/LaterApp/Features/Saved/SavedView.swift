import SwiftUI

struct SavedView: View {
  var body: some View {
    ShellScreen(title: "Saved") {
      NotConnectedView(
        identifier: "saved.notConnected",
        message: "Not connected yet — this build can't show your saves.",
        detail: "Your saves appear here once this build is connected to your account."
      )
    }
  }
}
