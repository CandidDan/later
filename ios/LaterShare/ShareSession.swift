import Foundation
import LaterKit

/// Read the shared credential on every request. Never refresh or rewrite the app's session
/// from an extension: the app may have signed out or changed accounts while this sheet was open.
// Supabase 2.55.6 SessionStorage uses the default JSONEncoder, not its wire encoder.
// Keep the SDK encoding regression test: stored keys are camelCase.
struct ShareSession: Decodable, Sendable {
  let accessToken: String
  let expiresAt: TimeInterval
  let user: User

  struct User: Decodable, Sendable {
    let id: UUID
  }
}

struct ShareTokenProvider: TokenProvider {
  let ownerID: UUID
  let readSession: @Sendable () throws -> Data?
  var now: @Sendable () -> Date = { Date() }

  func accessToken() async throws -> String {
    try Task.checkCancellation()
    guard let data = try readSession(),
      let session = try? JSONDecoder().decode(ShareSession.self, from: data),
      session.user.id == ownerID, session.expiresAt > now().timeIntervalSince1970,
      !session.accessToken.isEmpty
    else { throw LaterAPIError.sessionEnded }
    return session.accessToken
  }

  func refreshToken() async throws -> String {
    // Keep the capture queued for the app, which owns refresh and sign-in.
    throw LaterAPIError.sessionEnded
  }

  func sessionEnded() async {
    // A rejected extension request must not delete a newer session stored by the app.
  }
}

@MainActor
enum ShareComposition {
  static func make(input: ShareInput, info: [String: Any]) throws -> ShareViewModel {
    let configuration = try AppAuthConfiguration(info: info)
    let keychain = try KeychainSessionStorage(
      accessGroup: info["LATER_KEYCHAIN_ACCESS_GROUP"] as? String)
    guard let group = info["LATER_APP_GROUP"] as? String,
      !group.isEmpty, !group.contains("$("),
      let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group)
    else { throw AppAuthConfiguration.ConfigurationError.invalid }
    let storageKey = KeychainSessionStorage.sessionKey
    let read: @Sendable () throws -> Data? = {
      try keychain.retrieve(key: storageKey)
    }
    // An expired session still identifies the owner of an offline share. Delivery waits
    // for that same account to refresh in the app; it must never become an unassigned share.
    let session = try read().map { try JSONDecoder().decode(ShareSession.self, from: $0) }
    let delivery: CaptureDelivery?
    if let ownerID = session?.user.id {
      delivery = CaptureDelivery(
        api: try URLSessionLaterAPIClient(
          baseURL: configuration.apiBaseURL,
          tokenProvider: ShareTokenProvider(ownerID: ownerID, readSession: read)))
    } else {
      delivery = nil
    }
    return ShareViewModel(
      url: input.url, text: input.text, ownerID: session?.user.id,
      storage: CaptureFileOutbox(parent: container), delivery: delivery)
  }
}
