import LaterKit
import SwiftUI

struct ListenView: View {
  var body: some View {
    ShellScreen(title: "Listen") {
      NotConnectedView(
        identifier: "listen.notConnected",
        message: "Not connected yet — this build can't reach your saves.",
        detail: "Once it can, Listen will suggest saves that fit "
          + "\(ListeningDuration.list(ListeningDuration.slots))."
      )
    }
  }
}
