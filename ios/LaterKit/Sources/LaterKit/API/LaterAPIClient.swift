import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public protocol TokenProvider: Sendable {
  func accessToken() async throws -> String
  /// Throw sessionEnded only for rejected/missing credentials; propagate transient failures.
  func refreshToken() async throws -> String
  func sessionEnded() async
}

public enum LaterAPIError: Error, Equatable, Sendable {
  case invalidURL
  case invalidResponse
  case sessionEnded
  case server(status: Int, message: String?)
}

public struct LaterAPIRequest: Sendable {
  public enum Method: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
  }

  public let path: String
  public let method: Method
  public let body: Data?
  public let query: [URLQueryItem]

  /// Paths are relative to the configured base URL, without a leading slash or URL encoding.
  public init(
    path: String, method: Method = .get, body: Data? = nil, query: [URLQueryItem] = []
  ) {
    self.path = path
    self.method = method
    self.body = body
    self.query = query
  }
}

public protocol LaterAPIClient: Sendable {
  func send(_ request: LaterAPIRequest) async throws -> Data
}

public protocol LaterHTTPTransport: Sendable {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// A private, non-caching session. Redirects are rejected before a second request can send a token.
public final class URLSessionLaterHTTPTransport: LaterHTTPTransport {
  private let session: URLSession

  public init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(
      configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
  }

  deinit {
    session.invalidateAndCancel()
  }

  public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw LaterAPIError.invalidResponse
    }
    return (data, response)
  }
}

final class RejectRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public actor URLSessionLaterAPIClient: LaterAPIClient {
  private let baseURL: URL
  private let tokenProvider: any TokenProvider
  private let transport: any LaterHTTPTransport
  private var ended = false
  private var refreshGeneration = 0
  private var refreshTask: Task<String, Error>?

  public init(
    baseURL: URL, tokenProvider: any TokenProvider,
    transport: any LaterHTTPTransport = URLSessionLaterHTTPTransport()
  ) throws {
    guard baseURL.scheme == "https", baseURL.host != nil,
      baseURL.user == nil, baseURL.password == nil,
      baseURL.query == nil, baseURL.fragment == nil
    else {
      throw LaterAPIError.invalidURL
    }
    self.baseURL = baseURL
    self.tokenProvider = tokenProvider
    self.transport = transport
  }

  public func send(_ request: LaterAPIRequest) async throws -> Data {
    // Validate before asking for a credential. No caller can supply an origin or escape the base.
    let url = try requestURL(request)
    try ensureActive()
    let generation = refreshGeneration
    let token = try await tokenProvider.accessToken()
    try await validateToken(token)
    var (data, response) = try await perform(request, url: url, token: token)
    if response.statusCode == 401 {
      let refreshed = try await refresh(after: generation)
      (data, response) = try await perform(request, url: url, token: refreshed)
    }
    try ensureActive()
    if response.statusCode == 401 || response.statusCode == 403 {
      await endSession()
      throw LaterAPIError.sessionEnded
    }
    guard (200..<300).contains(response.statusCode) else {
      let error = try? JSONDecoder().decode(ErrorBody.self, from: data)
      throw LaterAPIError.server(status: response.statusCode, message: error?.error)
    }
    return data
  }

  private func requestURL(_ request: LaterAPIRequest) throws -> URL {
    let parts = request.path.split(separator: "/", omittingEmptySubsequences: false)
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    guard !parts.isEmpty,
      parts.allSatisfy({ part in
        !part.isEmpty && part != "." && part != ".."
          && part.unicodeScalars.allSatisfy { allowed.contains($0) }
      })
    else {
      throw LaterAPIError.invalidURL
    }
    let url = parts.reduce(baseURL) { $0.appendingPathComponent(String($1)) }
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw LaterAPIError.invalidURL
    }
    components.queryItems = request.query.isEmpty ? nil : request.query
    guard let result = components.url else { throw LaterAPIError.invalidURL }
    return result
  }

  private func perform(
    _ input: LaterAPIRequest, url: URL, token: String
  ) async throws
    -> (Data, HTTPURLResponse)
  {
    try ensureActive()
    try Task.checkCancellation()
    var request = URLRequest(url: url)
    request.httpMethod = input.method.rawValue
    request.httpBody = input.body
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if input.body != nil {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let result = try await transport.data(for: request)
    try ensureActive()
    return result
  }

  private func refresh(after generation: Int) async throws -> String {
    try ensureActive()
    do {
      let token: String
      if refreshGeneration != generation {
        token = try await tokenProvider.accessToken()
      } else {
        let task: Task<String, Error>
        if let pending = refreshTask {
          task = pending
        } else {
          let provider = tokenProvider
          task = Task { try await provider.refreshToken() }
          refreshTask = task
        }
        token = try await task.value
        if refreshGeneration == generation {
          refreshGeneration += 1
          refreshTask = nil
        }
      }
      try await validateToken(token)
      return token
    } catch is CancellationError {
      refreshTask = nil
      throw CancellationError()
    } catch {
      refreshTask = nil
      if error as? LaterAPIError == .sessionEnded { await endSession() }
      throw error
    }
  }

  private func validateToken(_ token: String) async throws {
    try ensureActive()
    guard !token.isEmpty, !token.contains(where: { $0.isWhitespace || $0.isNewline }) else {
      await endSession()
      throw LaterAPIError.sessionEnded
    }
  }

  private func ensureActive() throws {
    if ended { throw LaterAPIError.sessionEnded }
  }

  private func endSession() async {
    guard !ended else { return }
    ended = true
    refreshTask?.cancel()
    refreshTask = nil
    await tokenProvider.sessionEnded()
  }
}

private struct ErrorBody: Decodable {
  let error: String
}
