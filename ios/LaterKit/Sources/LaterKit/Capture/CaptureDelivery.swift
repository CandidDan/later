import Foundation

public enum CaptureDeliveryResult: Equatable, Sendable {
  case saved
  case signInRequired
  case retryLater
  case invalid
}

/// Uses the existing authenticated, non-caching, redirect-rejecting API client.
public struct CaptureDelivery: Sendable {
  private let api: any LaterAPIClient

  public init(api: any LaterAPIClient) {
    self.api = api
  }

  public func send(_ capture: CaptureRequest) async throws -> CaptureDeliveryResult {
    try Task.checkCancellation()
    let body: Data
    do {
      body = try capture.encodedBody()
    } catch {
      return .invalid
    }
    do {
      let data = try await api.send(
        LaterAPIRequest(path: "api/app/captures", method: .post, body: body))
      try Task.checkCancellation()
      // A malformed 2xx must not destroy the only durable copy of the share.
      _ = try JSONDecoder().decode(Receipt.self, from: data)
      return .saved
    } catch is CancellationError {
      throw CancellationError()
    } catch LaterAPIError.sessionEnded {
      try Task.checkCancellation()
      return .signInRequired
    } catch LaterAPIError.server(let status, _) {
      try Task.checkCancellation()
      if status == 400 { return .invalid }
      if status == 401 || status == 403 { return .signInRequired }
      return .retryLater
    } catch {
      return .retryLater
    }
  }

  private struct Receipt: Decodable {
    let captureId: UUID
    let repeated: Bool
  }
}

public protocol CaptureOutboxStorage: Sendable {
  func pending() async throws -> [PendingCapture]
  func insert(_ capture: PendingCapture) async throws
  func remove(requestID: UUID) async throws
}

public struct CaptureDrainReport: Equatable, Sendable {
  public var saved = 0
  public var invalid = 0
  public var signInRequired = false

  public init() {}
}

/// Serializes foreground/background drains within one process. The extension and app may still
/// race: both send the same requestId, so the server's idempotency constraint is authoritative.
public actor CaptureOutboxDrainer {
  private let storage: any CaptureOutboxStorage
  private let delivery: CaptureDelivery
  private var draining = false
  private let reject: (@Sendable (PendingCapture) async throws -> Void)?

  public init(
    storage: any CaptureOutboxStorage, delivery: CaptureDelivery,
    reject: (@Sendable (PendingCapture) async throws -> Void)? = nil
  ) {
    self.storage = storage
    self.delivery = delivery
    self.reject = reject
  }

  public func drain(ownerID: UUID) async throws -> CaptureDrainReport {
    guard !draining else { return CaptureDrainReport() }
    draining = true
    defer { draining = false }
    var report = CaptureDrainReport()
    for capture in try await storage.pending() where capture.ownerID == ownerID {
      try Task.checkCancellation()
      switch try await delivery.send(capture.request) {
      case .saved:
        try await storage.remove(requestID: capture.request.requestId)
        report.saved += 1
      case .invalid:
        if let reject {
          try await reject(capture)
        } else {
          try await storage.remove(requestID: capture.request.requestId)
        }
        report.invalid += 1
      case .signInRequired:
        report.signInRequired = true
        return report
      case .retryLater:
        return report
      }
    }
    return report
  }
}
