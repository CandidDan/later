import SwiftUI

@main
struct LaterApp: App {
  @State private var auth: AuthService? = try? AuthServiceFactory.make()

  var body: some Scene {
    WindowGroup {
      if let auth {
        RootView()
          .environment(auth)
          .task { await auth.restore() }
          .onOpenURL { url in Task { await auth.handleCallback(url) } }
      } else {
        ContentUnavailableView(
          "Sign-in isn't configured", systemImage: "gearshape",
          description: Text(
            "This build needs its Later connection settings. See the iPhone setup guide."))
      }
    }
  }
}
