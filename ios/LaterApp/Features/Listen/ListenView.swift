import LaterKit
import SwiftUI

struct ListenView: View {
  var body: some View {
    ShellScreen(title: "Listen") {
      NotConnectedView(
        identifier: "listen.empty",
        message: "Nothing to listen to yet.",
        detail: "This build will soon suggest saves that fit "
          + "\(ListeningDuration.list(ListeningDuration.slots))."
      )
    }
  }
}
