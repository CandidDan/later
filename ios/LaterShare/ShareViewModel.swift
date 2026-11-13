import Foundation
import LaterKit
import Observation

/// The composition root must bind delivery to ownerID for the lifetime of this sheet.
/// Signed-out shares remain unassigned until the app obtains explicit account confirmation.
@MainActor
@Observable
final class ShareViewModel {
  var note = ""
  private(set) var isSaving = false
  private(set) var message: String?
  private(set) var isFinished = false
  private(set) var didSaveRemotely = false
  private(set) var persistedRequest: CaptureRequest?

  private let url: String?
  private let text: String?
  private let ownerID: UUID?
  private let storage: any CaptureOutboxStorage
  private let delivery: CaptureDelivery?
  private let requestID = UUID()
  private let sharedAt = Date()

  init(
    url: String? = nil, text: String? = nil, ownerID: UUID?,
    storage: any CaptureOutboxStorage, delivery: CaptureDelivery?
  ) {
    self.url = url
    self.text = text
    self.ownerID = ownerID
    self.storage = storage
    self.delivery = delivery
  }

  private var request: CaptureRequest {
    persistedRequest
      ?? CaptureRequest(
        requestId: requestID, url: url, text: text,
        note: note.isEmpty ? nil : note, sharedAt: sharedAt)
  }

  var validationMessage: String? { request.validationMessage }
  var canSave: Bool { !isSaving && !isFinished && validationMessage == nil }

  func save() async {
    guard canSave else { return }
    isSaving = true
    message = nil
    defer { isSaving = false }
    let capture = request
    do {
      try Task.checkCancellation()
      try await storage.insert(PendingCapture(request: capture, ownerID: ownerID))
      persistedRequest = capture
    } catch {
      message = "Couldn't save. Please try again."
      return
    }
    // Never let an unassigned share use a token that appeared after the sheet opened.
    guard ownerID != nil, let delivery else {
      message = "Open Later to sign in"
      isFinished = true
      return
    }
    do {
      switch try await delivery.send(capture) {
      case .saved:
        // A removal failure is safe: the app retries the same idempotent request later.
        try? await storage.remove(requestID: capture.requestId)
        didSaveRemotely = true
        message = "Saved for Later ✓"
      case .retryLater:
        message = "Saved — will send when you're online"
      case .signInRequired:
        message = "Open Later to sign in"
      case .invalid:
        try await storage.remove(requestID: capture.requestId)
        message = "Couldn't save. Check the shared link or text."
      }
      isFinished = true
    } catch is CancellationError {
      // The durable request remains available to the app after the sheet is dismissed.
      message = "Saved — will send when you're online"
      isFinished = true
    } catch {
      message = "Couldn't finish saving. Open Later to try again."
      isFinished = true
    }
  }
}
