import Foundation
import LaterKit
import SwiftUI
import UIKit
import XCTest

@MainActor
final class ShareControllerTests: XCTestCase {
  func testHostsLoadedInputAndPreservesSavedAcknowledgementUntilDone() async throws {
    let input = ShareInput(url: "https://example.org/article", text: nil)
    let storage = ControllerOutbox()
    let model = ShareViewModel(
      url: input.url, ownerID: UUID(), storage: storage,
      delivery: CaptureDelivery(api: ControllerAPI()))
    let controller = ShareViewController()
    controller.loadInput = { _ in input }
    var composed: ShareInput?
    controller.makeModel = { received, _ in
      composed = received; return model
    }
    var completions = 0
    controller.onComplete = { completions += 1 }
    let window = try host(controller)
    defer { window.isHidden = true }
    await controller.loadTask?.value
    await render(controller)
    XCTAssertEqual(composed, input)
    XCTAssertEqual(controller.presentation, .ready)
    XCTAssertEqual(controller.children.count, 1, "Loading host must be replaced, not stacked")
    XCTAssertTrue(controller.children[0].view.superview === controller.view)
    try attach(controller, name: "Share link preview")
    model.note = "Read tomorrow"
    await model.save()
    await render(controller)
    try attach(controller, name: "Share saved acknowledgement")
    XCTAssertEqual(model.message, "Saved for Later ✓")
    XCTAssertTrue(model.isFinished)
    XCTAssertEqual(completions, 0, "Keep acknowledgement visible until Done")
    let pending = await storage.pending()
    XCTAssertTrue(pending.isEmpty)
    controller.finish()
    controller.finish()
    XCTAssertEqual(completions, 1)
    XCTAssertEqual(controller.presentation, .finished)
  }

  func testUnsupportedInputAndConfigurationFailureUseSafeMessages() async throws {
    for isInputError in [true, false] {
      let controller = ShareViewController()
      controller.loadInput = { _ in
        if isInputError { throw ShareInputError.unsupported }
        return ShareInput(url: nil, text: "Read")
      }
      controller.makeModel = { _, _ in
        throw NSError(domain: "private-keychain-secret", code: 123)
      }
      let window = try host(controller)
      await controller.loadTask?.value
      await render(controller)
      let expected =
        isInputError
        ? "Share a web link or plain text with Later."
        : "Couldn't open Later. Open the app and try sharing again."
      try attach(
        controller, name: isInputError ? "Unsupported share" : "Share configuration failure")
      XCTAssertEqual(controller.presentation, .failure(expected))
      XCTAssertEqual(controller.children.count, 1)
      controller.finish()
      XCTAssertEqual(controller.presentation, .finished)
      window.isHidden = true
    }
  }

  func testDisappearanceCancelsLoadingWithoutShowingFailureOrComposing() async {
    let controller = ShareViewController()
    controller.loadInput = { _ in
      try await Task.sleep(for: .seconds(60))
      return ShareInput(url: nil, text: "Read")
    }
    controller.makeModel = { _, _ in
      XCTFail("A dismissed extension must not compose capture services")
      throw CancellationError()
    }
    controller.loadViewIfNeeded()
    controller.viewDidDisappear(false)
    await controller.loadTask?.value
    XCTAssertTrue(controller.loadTask?.isCancelled == true)
    XCTAssertEqual(controller.presentation, .loading)
  }

  func testSignedOutAndInvalidSheetStatesRenderWithoutSending() async throws {
    for input in [
      ShareInput(url: nil, text: "Read"), ShareInput(url: "file:///private", text: nil),
    ] {
      let storage = ControllerOutbox()
      let model = ShareViewModel(
        url: input.url, text: input.text, ownerID: nil, storage: storage, delivery: nil)
      let controller = ShareViewController()
      controller.loadInput = { _ in input }
      controller.makeModel = { _, _ in model }
      let window = try host(controller)
      await controller.loadTask?.value
      await render(controller)
      await model.save()
      await render(controller)
      let pending = await storage.pending()
      if input.url == nil {
        XCTAssertEqual(model.message, "Open Later to sign in")
        XCTAssertEqual(pending.count, 1)
      } else {
        XCTAssertFalse(model.canSave)
        XCTAssertNotNil(model.validationMessage)
        XCTAssertTrue(pending.isEmpty)
      }
      controller.finish()
      window.isHidden = true
    }
  }

  private func attach(_ controller: UIViewController, name: String) throws {
    let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
      XCTAssertTrue(
        controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true),
        "The view hierarchy must actually render")
    }
    let pixels = try XCTUnwrap(image.cgImage?.dataProvider?.data) as Data
    XCTAssertGreaterThan(Set(pixels).count, 8, "A blank image is not screenshot evidence")
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func host(_ controller: UIViewController) throws -> UIWindow {
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = scene.coordinateSpace.bounds
    window.rootViewController = controller
    window.makeKeyAndVisible()
    controller.loadViewIfNeeded()
    return window
  }

  private func render(_ controller: UIViewController) async {
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    // Let SwiftUI apply the observable state to the hosted hierarchy.
    try? await Task.sleep(for: .milliseconds(350))
    controller.view.layoutIfNeeded()
  }
}

private actor ControllerOutbox: CaptureOutboxStorage {
  private var items: [PendingCapture] = []
  func pending() -> [PendingCapture] { items }
  func insert(_ capture: PendingCapture) { items.append(capture) }
  func remove(requestID: UUID) { items.removeAll { $0.request.requestId == requestID } }
}

private struct ControllerAPI: LaterAPIClient {
  func send(_ request: LaterAPIRequest) async throws -> Data {
    Data(#"{"captureId":"00000000-0000-4000-8000-000000000001","repeated":false}"#.utf8)
  }
}
