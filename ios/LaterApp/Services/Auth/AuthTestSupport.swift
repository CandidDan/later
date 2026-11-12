#if DEBUG
  import Auth
  import Foundation

  /// Debug-only, in-memory authentication for simulator UI tests. Never makes network requests.
  @MainActor
  enum AuthTestSupport {
    static func makeService() -> AuthService {
      let args = ProcessInfo.processInfo.arguments
      return AuthService(
        backend: Backend(
          signedIn: args.contains("--auth-signed-in"),
          failRequests: args.contains("--auth-error")),
        storage: Storage(), caches: Caches())
    }

    static var session: Session {
      let date = Date(timeIntervalSince1970: 1_700_000_000)
      return Session(
        accessToken: "ui-test-only", tokenType: "bearer", expiresIn: 3600,
        expiresAt: Date().timeIntervalSince1970 + 3600, refreshToken: "ui-test-only",
        user: User(
          id: UUID(), appMetadata: [:], userMetadata: [:], aud: "authenticated",
          email: "tester@later.invalid", createdAt: date, updatedAt: date))
    }

    final class Backend: LaterAuthBackend {
      var signedIn: Bool
      let failRequests: Bool
      init(signedIn: Bool, failRequests: Bool) {
        self.signedIn = signedIn
        self.failRequests = failRequests
      }
      func restoreSession() async throws -> Session? { signedIn ? AuthTestSupport.session : nil }
      func requestMagicLink(email: String, redirectTo: URL, shouldCreateUser: Bool) async throws {
        if failRequests { throw AppAuthConfiguration.ConfigurationError.invalid }
      }
      func completeSession(from url: URL) async throws -> Session {
        signedIn = true
        return AuthTestSupport.session
      }
      func currentSession() async throws -> Session { AuthTestSupport.session }
      func refreshSession() async throws -> Session { AuthTestSupport.session }
      func signOut() async throws { signedIn = false }
    }

    struct Storage: SessionStorageClearing {
      func store(key: String, value: Data) throws {}
      func retrieve(key: String) throws -> Data? { nil }
      func remove(key: String) throws {}
      func clearAll() throws {}
    }
    struct Caches: UserCacheCleaning {
      func clearAll() throws {}
    }
  }
#endif
