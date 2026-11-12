import Auth
import Foundation
import LaterKit
import Observation

@MainActor
@Observable
final class AuthService: TokenProvider {
  static let genericError = "We couldn't sign you in. Please try again."
  private(set) var session: Session?
  private(set) var isBusy = false
  private(set) var isRestoring = true
  private(set) var checkEmail = false
  private(set) var errorMessage: String?
  private(set) var cleanupRequired = false

  private let backend: any LaterAuthBackend
  private let storage: any SessionStorageClearing
  private let caches: any UserCacheCleaning
  private var restoreTask: Task<Void, Never>?
  private var requestTask: Task<Void, Never>?
  private var completingCallback = false
  private var generation = 0

  init(
    backend: any LaterAuthBackend, storage: any SessionStorageClearing,
    caches: any UserCacheCleaning
  ) {
    self.backend = backend
    self.storage = storage
    self.caches = caches
  }

  func restore() async {
    if let restoreTask { return await restoreTask.value }
    let task = Task { @MainActor in
      do {
        session = try await backend.restoreSession()
      } catch {
        if Self.endsSession(error) {
          await clearSession()
        } else {
          errorMessage = Self.genericError
        }
      }
      isRestoring = false
    }
    restoreTask = task
    await task.value
  }

  func requestMagicLink(email: String) async {
    await restore()
    guard !isBusy, !cleanupRequired, session == nil,
      let redirect = URL(string: "later://auth-callback")
    else { return }
    isBusy = true
    errorMessage = nil
    checkEmail = false
    let task = Task { @MainActor in
      defer { isBusy = false }
      do {
        try await backend.requestMagicLink(
          email: email.trimmingCharacters(in: .whitespacesAndNewlines),
          redirectTo: redirect, shouldCreateUser: false)
        checkEmail = true
      } catch {
        errorMessage = Self.genericError
      }
    }
    requestTask = task
    await task.value
  }

  func handleCallback(_ url: URL) async {
    guard Self.isCallback(url) else { return }
    await restore()
    if let requestTask { await requestTask.value }
    guard session == nil, !completingCallback, !cleanupRequired, !isBusy else { return }
    completingCallback = true
    isBusy = true
    defer {
      completingCallback = false
      isBusy = false
    }
    do {
      session = try await backend.completeSession(from: url)
      generation += 1
      checkEmail = false
      errorMessage = nil
    } catch {
      await clearSession()
      errorMessage = Self.genericError
    }
  }

  static func isCallback(_ url: URL) -> Bool {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme == "later", parts.host == "auth-callback", parts.path.isEmpty,
      parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
      let items = parts.queryItems, items.count == 1, items[0].name == "code",
      let code = items[0].value, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return false }
    return true
  }

  func signOut() async {
    guard !isBusy else { return }
    isBusy = true
    session = nil
    generation += 1
    defer { isBusy = false }
    // A network failure cannot keep local credentials or private cached data signed in.
    try? await backend.signOut()
    await clearSession()
  }

  func accessToken() async throws -> String {
    try await token(refresh: false)
  }

  func refreshToken() async throws -> String {
    try await token(refresh: true)
  }

  func sessionEnded() async {
    await signOut()
  }

  private func token(refresh: Bool) async throws -> String {
    guard session != nil, !isBusy, !cleanupRequired else { throw LaterAPIError.sessionEnded }
    let currentGeneration = generation
    do {
      let current = try await (refresh ? backend.refreshSession() : backend.currentSession())
      guard generation == currentGeneration, session != nil else {
        throw LaterAPIError.sessionEnded
      }
      session = current
      return current.accessToken
    } catch {
      guard generation == currentGeneration else { throw LaterAPIError.sessionEnded }
      guard Self.endsSession(error) else { throw error }
      await signOut()
      throw LaterAPIError.sessionEnded
    }
  }

  private static func endsSession(_ error: any Error) -> Bool {
    if error as? LaterAPIError == .sessionEnded { return true }
    guard let error = error as? AuthError else { return false }
    switch error {
    case .sessionMissing:
      return true
    case .api(_, _, _, let response):
      // Only credential rejection ends a session. Timeouts and rate limits are retryable.
      return [400, 401, 403].contains(response.statusCode)
    default:
      return false
    }
  }

  private func clearSession() async {
    session = nil
    checkEmail = false
    generation += 1
    var failed = false
    do { try storage.clearAll() } catch { failed = true }
    do { try caches.clearAll() } catch { failed = true }
    cleanupRequired = failed
    errorMessage = failed ? "Couldn't clear this device. Please retry signing out." : nil
  }
}
