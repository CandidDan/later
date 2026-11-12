import AppIntents
import Foundation
import LaterKit

/// An app-owned enum keeps App Intents metadata out of the Linux-testable planner.
enum SiriListenSlot: Int, AppEnum {
  case ten = 10
  case fifteen = 15
  case thirty = 30

  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Listening time" }
  static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
    [.ten: "10", .fifteen: "15", .thirty: "30"]
  }
  var slot: ListenSlot {
    switch self {
    case .ten: .ten
    case .fifteen: .fifteen
    case .thirty: .thirty
    }
  }
}

struct PlayLaterIntent: AudioPlaybackIntent {
  static var title: LocalizedStringResource { "Play Later" }
  static var description: IntentDescription { "Listen to audio already prepared on this iPhone." }
  static var openAppWhenRun: Bool { false }
  static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

  @Parameter(title: "Minutes") var minutes: SiriListenSlot?

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let message = await SiriPlaybackRuntime.play(minutes: minutes)
    return .result(dialog: IntentDialog(stringLiteral: message))
  }
}

struct LaterShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PlayLaterIntent(),
      phrases: [
        "Play \(.applicationName)",
        "Listen to \(.applicationName)",
        "Play a \(\.$minutes) minute \(.applicationName)",
      ],
      shortTitle: "Play Later", systemImageName: "headphones")
  }
}

@MainActor
enum SiriPlaybackRuntime {
  struct Services {
    let auth: AuthService
    let coordinator: NarrationCoordinator
  }
  private static var retained: Services?

  /// The app and App Intent share one audio engine, including on a cold background launch.
  static func services() throws -> Services {
    if let retained { return retained }
    let auth = try AuthServiceFactory.make()
    let value = Services(auth: auth, coordinator: NarrationCoordinator(auth: auth))
    retained = value
    return value
  }

  static func play(
    minutes: SiriListenSlot?, coordinator supplied: NarrationCoordinator? = nil
  ) async -> String {
    do {
      let coordinator = try supplied ?? services().coordinator
      guard await coordinator.prepareLocal() else {
        return "Open Later to sign in and prepare something to listen to."
      }
      return PlayLaterAction.perform(minutes: minutes, model: .live(coordinator))
    } catch {
      return "Couldn't open your audio. Open Later and try again."
    }
  }
}

@MainActor
enum PlayLaterAction {
  static func perform(minutes: SiriListenSlot?, model: ListenViewModel) -> String {
    model.select(minutes?.slot ?? .fifteen)
    if let message = model.message { return message }
    if minutes == nil, let item = model.continuing {
      return model.playItem(item.id)
        ? "Resuming your listen in Later."
        : (model.message ?? "Couldn't start this audio. Open Later and try again.")
    }
    guard let plan = model.plan, !plan.items.isEmpty else {
      return model.longer.isEmpty
        ? "Nothing's ready to listen to yet in Later."
        : "Nothing ready fits this slot in Later. Try a longer listen."
    }
    guard model.playPlan() else {
      return model.message ?? "Your ready audio changed. Ask Later to play again."
    }
    // The view model rechecks local files before starting; report that final plan's duration.
    let current = model.plan ?? plan
    let duration = Int(current.total / 60)
    let amount = duration == 0 ? "less than a minute" : "\(duration) minutes"
    var message = "Playing \(amount) from Later."
    if case .under = current.fill {
      message +=
        current.tooLong.isEmpty
        ? " That's everything ready right now."
        : " That's everything that fits right now."
    }
    return message
  }
}
