import Foundation
import LaterKit
import Observation

/// One instance per authenticated session, shared by foreground and background library work.
@MainActor
@Observable
final class CaptureRetryModel {
  private(set) var message: String?
  private(set) var hasPending = false
  private(set) var unassigned: [PendingCapture] = []
  private let ownerID: UUID
  private let storage: CaptureFileOutbox
  private let drainer: CaptureOutboxDrainer
  private let isActive: @MainActor () -> Bool
  private var running = false

  init(
    ownerID: UUID, storage: CaptureFileOutbox, client: any LaterAPIClient,
    isActive: @escaping @MainActor () -> Bool
  ) {
    self.ownerID = ownerID
    self.storage = storage
    self.isActive = isActive
    drainer = CaptureOutboxDrainer(
      storage: storage, delivery: CaptureDelivery(api: client),
      reject: { try await storage.reject($0) })
  }

  @discardableResult
  func retry() async -> Int {
    guard isActive(), !running, !Task.isCancelled else { return 0 }
    running = true
    defer { running = false }
    do {
      let report = try await drainer.drain(ownerID: ownerID)
      let pending = try await storage.pending()
      let rejected = await storage.hasRejection(ownerID: ownerID)
      guard isActive(), !Task.isCancelled else { return 0 }
      hasPending = pending.contains { $0.ownerID == ownerID }
      unassigned = pending.filter { $0.ownerID == nil }
      message = rejected ? "Couldn't save a shared item. Please share it again." : nil
      return report.saved
    } catch {
      guard isActive(), !Task.isCancelled else { return 0 }
      hasPending = true
      message = "Couldn't retry shared items. Please try again."
      return 0
    }
  }

  /// The UI passes only IDs displayed when confirmation opened, never newly arriving shares.
  func assignConfirmed(_ requestIDs: [UUID]) async {
    guard isActive(), !running, !Task.isCancelled else { return }
    running = true
    do {
      let allowed = Set(unassigned.map { $0.request.requestId })
      for id in Set(requestIDs) where allowed.contains(id) {
        guard isActive(), !Task.isCancelled else { break }
        try await storage.assign(requestID: id, ownerID: ownerID)
      }
      running = false
      _ = await retry()
    } catch {
      running = false
      if isActive(), !Task.isCancelled {
        message = "Couldn't assign shared items. Please try again."
      }
    }
  }

  func dismissNotice() async {
    guard isActive() else { return }
    do {
      try await storage.dismissRejection(ownerID: ownerID)
      if isActive() { message = nil }
    } catch { }
  }

  static func make(auth: AuthService) throws -> CaptureRetryModel {
    guard let ownerID = auth.session?.user.id else { throw LaterAPIError.sessionEnded }
    let generation = auth.sessionGeneration
    let info = Bundle.main.infoDictionary ?? [:]
    let configuration = try AppAuthConfiguration(info: info)
    guard let group = info["LATER_APP_GROUP"] as? String,
      let parent = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw AppAuthConfiguration.ConfigurationError.invalid }
    let active = { @MainActor [weak auth] in
      auth?.session?.user.id == ownerID && auth?.sessionGeneration == generation
    }
    let provider = CaptureAccountTokenProvider(auth: auth, isActive: active)
    return CaptureRetryModel(
      ownerID: ownerID, storage: CaptureFileOutbox(parent: parent),
      client: try URLSessionLaterAPIClient(baseURL: configuration.apiBaseURL, tokenProvider: provider),
      isActive: active)
  }
}

/// An old drain can never acquire a newly signed-in account's credential, including on retry.
@MainActor
final class CaptureAccountTokenProvider: TokenProvider {
  private let auth: AuthService
  private let isActive: @MainActor () -> Bool

  init(auth: AuthService, isActive: @escaping @MainActor () -> Bool) {
    self.auth = auth
    self.isActive = isActive
  }

  func accessToken() async throws -> String { try await token(refresh: false) }
  func refreshToken() async throws -> String { try await token(refresh: true) }
  func sessionEnded() async {
    if isActive() { await auth.sessionEnded() }
  }

  private func token(refresh: Bool) async throws -> String {
    guard isActive(), !Task.isCancelled else { throw LaterAPIError.sessionEnded }
    let token = try await (refresh ? auth.refreshToken() : auth.accessToken())
    guard isActive(), !Task.isCancelled else { throw LaterAPIError.sessionEnded }
    return token
  }
}
