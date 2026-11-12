import Auth
import Foundation
import LaterKit
import XCTest

@testable import Later

@MainActor
final class AuthServiceTests: XCTestCase {
  func testMagicLinkRequestShape() async throws {
    let storage = TestSessionStorage()
    let requests = AuthRequests()
    let backend = try makeRealBackend(storage: storage, requests: requests)
    let auth = AuthService(backend: backend, storage: storage, caches: TestCacheCleaner())
    await auth.requestMagicLink(email: "  person@example.com  ")
    XCTAssertTrue(auth.checkEmail)
    let recordedRequest = await requests.last()
    let request = try XCTUnwrap(recordedRequest)
    XCTAssertEqual(request.url?.path, "/auth/v1/otp")
    let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
    XCTAssertEqual(query?.queryItems?.first?.name, "redirect_to")
    XCTAssertEqual(query?.queryItems?.first?.value, "later://auth-callback")
    let body = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody))
        as? [String: Any])
    XCTAssertEqual(body["email"] as? String, "person@example.com")
    XCTAssertEqual(body["create_user"] as? Bool, false)
    XCTAssertEqual(body["code_challenge_method"] as? String, "s256")
    XCTAssertFalse(try XCTUnwrap(body["code_challenge"] as? String).isEmpty)
    XCTAssertNotNil(try storage.retrieve(key: SupabaseAuthBackend.storageKey + "-code-verifier"))
  }

  func testPKCECallbackExchangesStoredVerifierAndRestoresSession() async throws {
    let storage = TestSessionStorage()
    let requests = AuthRequests(session: AuthTestSupport.session)
    let backend = try makeRealBackend(storage: storage, requests: requests)
    let auth = AuthService(backend: backend, storage: storage, caches: TestCacheCleaner())
    await auth.requestMagicLink(email: "person@example.com")
    let verifier = try XCTUnwrap(
      storage.retrieve(key: SupabaseAuthBackend.storageKey + "-code-verifier"))
    await auth.handleCallback(
      try XCTUnwrap(URL(string: "later://auth-callback?code=one-time-code")))
    XCTAssertEqual(auth.session?.user.email, "tester@later.invalid")
    XCTAssertFalse(auth.checkEmail)
    let recordedRequest = await requests.last()
    let request = try XCTUnwrap(recordedRequest)
    XCTAssertEqual(request.url?.path, "/auth/v1/token")
    XCTAssertEqual(
      URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
        .queryItems?.first?.value, "pkce")
    let body = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody))
        as? [String: Any])
    XCTAssertEqual(body["auth_code"] as? String, "one-time-code")
    XCTAssertEqual(body["code_verifier"] as? String, String(decoding: verifier, as: UTF8.self))
    let newBackend = try makeRealBackend(storage: storage, requests: requests)
    let restored = try await newBackend.restoreSession()
    XCTAssertEqual(restored?.user.email, "tester@later.invalid")
  }

  func testMalformedAndForeignCallbacksDoNothing() async throws {
    let backend = ServiceBackend()
    let auth = makeService(backend)
    await auth.restore()
    for raw in [
      "https://auth-callback?code=x", "later://other?code=x", "later://auth-callback/path?code=x",
      "later://auth-callback", "later://auth-callback?code=",
      "later://auth-callback#access_token=x",
      "later://user@auth-callback?code=x", "later://auth-callback:42?code=x",
      "later://auth-callback?code=x&code=y",
      "later://auth-callback?code=x&redirect_to=https://evil.test",
    ] {
      await auth.handleCallback(try XCTUnwrap(URL(string: raw)))
    }
    XCTAssertEqual(backend.callbackCount, 0)
    XCTAssertNil(auth.session)
    XCTAssertNil(auth.errorMessage)
  }

  func testCallbackCompletesSessionAndDuplicateDoesNotExchangeAgain() async throws {
    let backend = ServiceBackend()
    let auth = makeService(backend)
    let callback = try XCTUnwrap(URL(string: "later://auth-callback?code=stub"))
    await auth.handleCallback(callback)
    await auth.handleCallback(callback)
    XCTAssertNotNil(auth.session)
    XCTAssertEqual(backend.callbackCount, 1)
  }

  func testAllSignInFailuresUseSameGenericMessage() async throws {
    let backend = ServiceBackend()
    backend.fail = true
    let auth = makeService(backend)
    await auth.requestMagicLink(email: "unknown@example.com")
    XCTAssertEqual(auth.errorMessage, AuthService.genericError)
    XCTAssertFalse(auth.checkEmail)
    await auth.handleCallback(try XCTUnwrap(URL(string: "later://auth-callback?code=expired")))
    XCTAssertEqual(auth.errorMessage, AuthService.genericError)
    XCTAssertNil(auth.session)
  }

  func testSignOutClearsSessionAndCaches() async throws {
    let backend = ServiceBackend()
    backend.initialSession = AuthTestSupport.session
    let storage = TestSessionStorage()
    try storage.store(key: "session", value: Data("private".utf8))
    try storage.store(key: "verifier", value: Data("private".utf8))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("private audio".utf8).write(to: directory.appendingPathComponent("audio"))
    defer { try? FileManager.default.removeItem(at: directory) }
    let auth = AuthService(
      backend: backend, storage: storage, caches: UserCacheCleaner(directories: [directory]))
    await auth.restore()
    XCTAssertNotNil(auth.session)
    await auth.signOut()
    XCTAssertNil(auth.session)
    XCTAssertNil(try storage.retrieve(key: "session"))
    XCTAssertNil(try storage.retrieve(key: "verifier"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    XCTAssertEqual(backend.signOutCount, 1)
    XCTAssertFalse(auth.cleanupRequired)
  }

  func testOfflineSignOutStillClearsLocalData() async {
    let backend = ServiceBackend()
    backend.initialSession = AuthTestSupport.session
    let caches = TestCacheCleaner()
    let storage = TestSessionStorage()
    let auth = AuthService(backend: backend, storage: storage, caches: caches)
    await auth.restore()
    backend.fail = true
    await auth.signOut()
    XCTAssertNil(auth.session)
    XCTAssertEqual(storage.clearCount, 1)
    XCTAssertEqual(caches.clearCount, 1)
  }

  func testCleanupFailureBlocksSignInUntilRetry() async {
    let backend = ServiceBackend()
    let storage = TestSessionStorage()
    storage.failClear = true
    let caches = TestCacheCleaner()
    let auth = AuthService(backend: backend, storage: storage, caches: caches)
    await auth.restore()
    await auth.signOut()
    XCTAssertTrue(auth.cleanupRequired)
    XCTAssertEqual(caches.clearCount, 1, "cache cleanup still runs when Keychain fails")
    await auth.requestMagicLink(email: "person@example.com")
    XCTAssertEqual(backend.requestCount, 0)
    storage.failClear = false
    await auth.signOut()
    XCTAssertFalse(auth.cleanupRequired)
    await auth.requestMagicLink(email: "person@example.com")
    XCTAssertEqual(backend.requestCount, 1)
  }

  func testRefreshReturnsNewTokenAndSessionEndedClearsState() async throws {
    let backend = ServiceBackend()
    backend.initialSession = AuthTestSupport.session
    let auth = makeService(backend)
    await auth.restore()
    let token = try await auth.accessToken()
    XCTAssertEqual(token, "ui-test-only")
    let refreshed = try await auth.refreshToken()
    XCTAssertEqual(refreshed, "refreshed-token")
    await auth.sessionEnded()
    XCTAssertNil(auth.session)
    do {
      _ = try await auth.accessToken()
      XCTFail("signed-out client returned a token")
    } catch {
      XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
    }
  }

  func testStorageWriteFailureNeverShowsSignedInShell() async throws {
    let storage = TestSessionStorage()
    let requests = AuthRequests(session: AuthTestSupport.session)
    let backend = try makeRealBackend(storage: storage, requests: requests)
    let auth = AuthService(backend: backend, storage: storage, caches: TestCacheCleaner())
    await auth.requestMagicLink(email: "person@example.com")
    storage.failWrite = true
    await auth.handleCallback(try XCTUnwrap(URL(string: "later://auth-callback?code=stub")))
    XCTAssertNil(auth.session)
    XCTAssertEqual(auth.errorMessage, AuthService.genericError)
  }

  func testOfflineRestoreKeepsExpiredSessionAndCachedFiles() async throws {
    let storage = TestSessionStorage()
    var saved = AuthTestSupport.session
    saved.expiresAt = Date().timeIntervalSince1970 - 3600
    let bytes = try AuthClient.Configuration.jsonEncoder.encode(saved)
    try storage.store(key: SupabaseAuthBackend.storageKey, value: bytes)
    let requests = AuthRequests()
    await requests.setFailure(URLError(.notConnectedToInternet))
    let backend = try makeRealBackend(storage: storage, requests: requests)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let audio = directory.appendingPathComponent("audio")
    try Data("private audio".utf8).write(to: audio)
    defer { try? FileManager.default.removeItem(at: directory) }
    let auth = AuthService(
      backend: backend, storage: storage, caches: UserCacheCleaner(directories: [directory]))
    await auth.restore()
    XCTAssertEqual(auth.session, saved)
    // The SDK may re-encode JSON; the durable session must retain all its values.
    let persisted = try XCTUnwrap(storage.retrieve(key: SupabaseAuthBackend.storageKey))
    XCTAssertEqual(try JSONDecoder().decode(Session.self, from: persisted), saved)
    XCTAssertEqual(try Data(contentsOf: audio), Data("private audio".utf8))
    XCTAssertEqual(storage.clearCount, 0)
    let request = await requests.last()
    XCTAssertNil(request, "Launch must not require the network, even for an expired token")
    XCTAssertFalse(auth.isRestoring)
  }

  func testTransientTokenFailuresPreserveSessionAndRetrySuccessfully() async throws {
    for refresh in [false, true] {
      for failure in [URLError(.notConnectedToInternet), URLError(.timedOut)] {
        try await assertTokenFailurePreservesSession(refresh: refresh, failure: failure)
      }
      for status in [408, 429, 503] {
        try await assertTokenFailurePreservesSession(refresh: refresh, status: status)
      }
    }
  }

  private func assertTokenFailurePreservesSession(
    refresh: Bool, failure: URLError? = nil, status: Int = 200
  ) async throws {
    let storage = TestSessionStorage()
    let caches = TestCacheCleaner()
    var saved = AuthTestSupport.session
    saved.expiresAt = Date().timeIntervalSince1970 - 3600
    let bytes = try AuthClient.Configuration.jsonEncoder.encode(saved)
    try storage.store(key: SupabaseAuthBackend.storageKey, value: bytes)
    var renewed = saved
    renewed.accessToken = "renewed-token"
    renewed.expiresAt = Date().timeIntervalSince1970 + 3600
    let requests = AuthRequests(session: renewed)
    await requests.setFailure(failure, status: status)
    let auth = AuthService(
      backend: try makeRealBackend(storage: storage, requests: requests),
      storage: storage, caches: caches)
    await auth.restore()
    do {
      _ = try await (refresh ? auth.refreshToken() : auth.accessToken())
      XCTFail("Expected transient failure")
    } catch {
      if let failure {
        XCTAssertEqual((error as? URLError)?.code, failure.code)
      } else if case .api(_, _, _, let response) = error as? AuthError {
        XCTAssertEqual(response.statusCode, status)
      } else {
        XCTFail("Expected HTTP error, got \(error)")
      }
    }
    XCTAssertEqual(auth.session, saved)
    // The SDK may re-encode JSON; the durable session must retain all its values.
    let persisted = try XCTUnwrap(storage.retrieve(key: SupabaseAuthBackend.storageKey))
    XCTAssertEqual(try JSONDecoder().decode(Session.self, from: persisted), saved)
    XCTAssertEqual(storage.clearCount, 0)
    XCTAssertEqual(caches.clearCount, 0)
    await requests.setFailure(nil)
    let token = try await (refresh ? auth.refreshToken() : auth.accessToken())
    XCTAssertEqual(token, "renewed-token")
    XCTAssertEqual(auth.session?.accessToken, "renewed-token")
  }

  func testRejectedRefreshClearsSessionAndCaches() async throws {
    for status in [400, 401, 403] {
      let storage = TestSessionStorage()
      let caches = TestCacheCleaner()
      let saved = AuthTestSupport.session
      try storage.store(
        key: SupabaseAuthBackend.storageKey,
        value: AuthClient.Configuration.jsonEncoder.encode(saved))
      let requests = AuthRequests()
      await requests.setFailure(nil, status: status)
      let auth = AuthService(
        backend: try makeRealBackend(storage: storage, requests: requests),
        storage: storage, caches: caches)
      await auth.restore()
      do {
        _ = try await auth.refreshToken()
        XCTFail("Rejected credentials returned a token")
      } catch {
        XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
      }
      XCTAssertNil(auth.session)
      XCTAssertNil(try storage.retrieve(key: SupabaseAuthBackend.storageKey))
      XCTAssertEqual(storage.clearCount, 1)
      XCTAssertEqual(caches.clearCount, 1)
    }
  }

  func testMissingSessionEndsSessionAndClearsCaches() async throws {
    let backend = ServiceBackend()
    backend.initialSession = AuthTestSupport.session
    let storage = TestSessionStorage()
    let caches = TestCacheCleaner()
    let auth = AuthService(backend: backend, storage: storage, caches: caches)
    await auth.restore()
    backend.tokenError = AuthError.sessionMissing
    do {
      _ = try await auth.accessToken()
      XCTFail("Missing session returned a token")
    } catch {
      XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
    }
    XCTAssertNil(auth.session)
    XCTAssertEqual(storage.clearCount, 1)
    XCTAssertEqual(caches.clearCount, 1)
  }

  private func makeService(_ backend: ServiceBackend) -> AuthService {
    AuthService(backend: backend, storage: TestSessionStorage(), caches: TestCacheCleaner())
  }

  private func makeRealBackend(
    storage: TestSessionStorage, requests: AuthRequests
  ) throws
    -> SupabaseAuthBackend
  {
    let configuration = try AppAuthConfiguration(info: [
      "SUPABASE_URL": "https://example.supabase.co", "LATER_API_BASE_URL": "https://notfor.now",
      "SUPABASE_ANON_KEY": "sb_publishable_test_fixture",
    ])
    return SupabaseAuthBackend(configuration: configuration, storage: storage) { request in
      try await requests.respond(to: request)
    }
  }
}

@MainActor
private final class ServiceBackend: LaterAuthBackend {
  var initialSession: Session?
  var fail = false
  var tokenError: (any Error)?
  var requestCount = 0
  var callbackCount = 0
  var signOutCount = 0
  func restoreSession() async throws -> Session? { initialSession }
  func requestMagicLink(email: String, redirectTo: URL, shouldCreateUser: Bool) async throws {
    requestCount += 1
    if fail { throw URLError(.notConnectedToInternet) }
  }
  func completeSession(from url: URL) async throws -> Session {
    callbackCount += 1
    if fail { throw URLError(.badServerResponse) }
    return AuthTestSupport.session
  }
  func currentSession() async throws -> Session {
    if let tokenError { throw tokenError }
    return AuthTestSupport.session
  }
  func refreshSession() async throws -> Session {
    var session = AuthTestSupport.session
    session.accessToken = "refreshed-token"
    return session
  }
  func signOut() async throws {
    signOutCount += 1
    if fail { throw URLError(.notConnectedToInternet) }
  }
}

private final class TestSessionStorage: SessionStorageClearing, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: Data] = [:]
  var failClear = false
  var failWrite = false
  private(set) var clearCount = 0
  func store(key: String, value: Data) throws {
    try lock.withLock {
      if failWrite { throw URLError(.cannotWriteToFile) }
      values[key] = value
    }
  }
  func retrieve(key: String) throws -> Data? { lock.withLock { values[key] } }
  func remove(key: String) throws { lock.withLock { values[key] = nil } }
  func clearAll() throws {
    try lock.withLock {
      clearCount += 1
      if failClear { throw URLError(.cannotWriteToFile) }
      values.removeAll()
    }
  }
}

private final class TestCacheCleaner: UserCacheCleaning, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var clearCount = 0
  func clearAll() throws { lock.withLock { clearCount += 1 } }
}

private actor AuthRequests {
  private var requests: [URLRequest] = []
  let session: Session?
  private var failure: URLError?
  private var status = 200
  func setFailure(_ failure: URLError?, status: Int = 200) {
    self.failure = failure
    self.status = status
  }
  init(session: Session? = nil) { self.session = session }
  func last() -> URLRequest? { requests.last }
  func respond(to request: URLRequest) throws -> (Data, URLResponse) {
    requests.append(request)
    if let failure { throw failure }
    let data: Data
    if status != 200 {
      let code: String
      switch status {
      case 408: code = "request_timeout"
      case 429: code = "over_request_rate_limit"
      case 500...599: code = "unexpected_failure"
      default: code = "refresh_token_not_found"
      }
      data = Data("{\"msg\":\"Token request failed\",\"error_code\":\"\(code)\"}".utf8)
    } else if request.url?.path == "/auth/v1/token", let session {
      data = try AuthClient.Configuration.jsonEncoder.encode(session)
    } else {
      data = Data("{}".utf8)
    }
    let response = try XCTUnwrap(
      HTTPURLResponse(
        url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: nil))
    return (data, response)
  }
}
