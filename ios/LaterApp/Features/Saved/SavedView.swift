import SwiftUI

struct SavedView: View {
  var body: some View {
    ShellScreen(title: "Saved") {
      NotConnectedView(
        identifier: "saved.empty",
        message: "Nothing to show yet.",
        detail: "You are signed in. Your saved library is coming in a later build."
      )
    }
  }
}
