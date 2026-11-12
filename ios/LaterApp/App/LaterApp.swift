import SwiftUI

@main
struct LaterApp: App {
  @State private var auth: AuthService?
  @State private var narration: NarrationCoordinator?
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let auth = try? AuthServiceFactory.make()
    _auth = State(initialValue: auth)
    let coordinator = auth.map { NarrationCoordinator(auth: $0) }
    _narration = State(initialValue: coordinator)
    coordinator?.registerBackgroundTask()
  }

  var body: some Scene {
    WindowGroup {
      if let auth, let narration {
        RootView()
          .environment(auth)
          .environment(narration)
          .task(id: auth.session?.user.id) { await narration.resume() }
          .onChange(of: scenePhase) { _, phase in
            if phase == .active {
              Task { await narration.resume() }
            } else {
              narration.pause()
              narration.schedule()
            }
          }
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
