import Auth
import Foundation

@MainActor
protocol LaterAuthBackend {
  func restoreSession() async throws -> Session?
  func requestMagicLink(email: String, redirectTo: URL, shouldCreateUser: Bool) async throws
  func completeSession(from url: URL) async throws -> Session
  func currentSession() async throws -> Session
  func refreshSession() async throws -> Session
  func signOut() async throws
}

/// The SDK owns PKCE and refresh tokens. Only its Auth product is linked into the app.
@MainActor
final class SupabaseAuthBackend: LaterAuthBackend {
  static let storageKey = "later.auth.session"
  private let client: AuthClient
  private let storage: any AuthLocalStorage

  init(
    configuration: AppAuthConfiguration,
    storage: any AuthLocalStorage,
    fetch: @escaping AuthClient.FetchHandler = AuthNetwork.fetch
  ) {
    self.storage = storage
    client = AuthClient(
      configuration: .init(
        url: configuration.supabaseURL.appendingPathComponent("auth/v1"),
        headers: ["apikey": configuration.anonymousKey],
        flowType: .pkce,
        storageKey: Self.storageKey,
        localStorage: storage,
        fetch: fetch,
        // Every token read refreshes on demand. No background writer survives sign-out.
        autoRefreshToken: false,
        emitLocalSessionAsInitialSession: true
      ))
  }

  func restoreSession() async throws -> Session? {
    // Restore local identity for offline use. Token reads refresh on demand before API access.
    guard let saved = client.currentSession else { return nil }
    return try verifyPersistence(saved)
  }

  func requestMagicLink(email: String, redirectTo: URL, shouldCreateUser: Bool) async throws {
    let verifierKey = Self.storageKey + "-code-verifier"
    let previous = try storage.retrieve(key: verifierKey)
    try await client.signInWithOTP(
      email: email, redirectTo: redirectTo, shouldCreateUser: shouldCreateUser)
    // The SDK logs storage failures instead of throwing them. Check the durable verifier.
    guard let verifier = try storage.retrieve(key: verifierKey), !verifier.isEmpty,
      verifier != previous
    else { throw AppAuthConfiguration.ConfigurationError.invalid }
  }

  func completeSession(from url: URL) async throws -> Session {
    try verifyPersistence(await client.session(from: url))
  }

  func currentSession() async throws -> Session {
    try verifyPersistence(await client.session)
  }

  func refreshSession() async throws -> Session {
    try verifyPersistence(await client.refreshSession())
  }

  func signOut() async throws {
    // The SDK removes its session before attempting the revocation request.
    try await client.signOut(scope: .local)
  }

  private func verifyPersistence(_ session: Session) throws -> Session {
    guard let data = try storage.retrieve(key: Self.storageKey),
      let saved = try? JSONDecoder().decode(Session.self, from: data),
      saved == session
    else { throw AppAuthConfiguration.ConfigurationError.invalid }
    return session
  }
}

final class AuthNetwork: NSObject, URLSessionTaskDelegate, Sendable {
  private static let delegate = AuthNetwork()
  private static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 30
    return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
  }()

  static func fetch(_ request: URLRequest) async throws -> (Data, URLResponse) {
    try await session.data(for: request)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
