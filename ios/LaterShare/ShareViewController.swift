import SwiftUI
import UIKit

/// Only the controller handles the extension context; capture logic is independently testable.
@MainActor
final class ShareViewController: UIViewController {
  enum Presentation: Equatable {
    case loading, ready, failure(String), finished
  }

  private(set) var presentation = Presentation.loading
  private(set) var loadTask: Task<Void, Never>?
  var loadInput: @MainActor ([NSExtensionItem]) async throws -> ShareInput = ShareInputLoader.load
  var makeModel: @MainActor (ShareInput, [String: Any]) throws -> ShareViewModel = {
    try ShareComposition.make(input: $0, info: $1)
  }
  var onComplete: (@MainActor () -> Void)?
  private var hosted: UIViewController?

  override func viewDidLoad() {
    super.viewDidLoad()
    show(AnyView(ProgressView("Loading share…")))
    loadTask = Task { [weak self] in
      guard let self else { return }
      do {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let input = try await loadInput(items)
        try Task.checkCancellation()
        let model = try makeModel(input, Bundle.main.infoDictionary ?? [:])
        presentation = .ready
        show(AnyView(ShareSheet(
          input: input, model: model,
          cancel: { [weak self] in self?.finish() },
          complete: { [weak self] in self?.finish() })))
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled, presentation != .finished else { return }
        // Never show Keychain, provider or configuration error details to the host app.
        let message = (error as? ShareInputError)?.localizedDescription
          ?? "Couldn't open Later. Open the app and try sharing again."
        presentation = .failure(message)
        show(AnyView(ShareFailureView(message: message, close: { [weak self] in self?.finish() })))
      }
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    loadTask?.cancel()
  }

  func finish() {
    guard presentation != .finished else { return }
    presentation = .finished
    loadTask?.cancel()
    if let onComplete { onComplete(); return }
    extensionContext?.completeRequest(returningItems: nil)
  }

  private func show(_ content: AnyView) {
    if let hosted {
      hosted.willMove(toParent: nil)
      hosted.view.removeFromSuperview()
      hosted.removeFromParent()
    }
    let controller = UIHostingController(rootView: content)
    addChild(controller)
    controller.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(controller.view)
    NSLayoutConstraint.activate([
      controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      controller.view.topAnchor.constraint(equalTo: view.topAnchor),
      controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    controller.didMove(toParent: self)
    hosted = controller
  }
}

private struct ShareFailureView: View {
  let message: String
  let close: () -> Void

  var body: some View {
    VStack(spacing: 20) {
      Text(message).multilineTextAlignment(.center)
      Button("Close", action: close)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(ColorToken.textPrimary.color)
    .background(ColorToken.background.color)
    .tint(ColorToken.accent.color)
  }
}
