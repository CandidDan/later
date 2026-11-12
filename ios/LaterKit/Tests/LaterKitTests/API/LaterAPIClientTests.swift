import Foundation
import XCTest

@testable import LaterKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@MainActor
final class LaterAPIClientTests: XCTestCase {
  private let baseURL = URL(string: "https://notfor.now")

  func testAttachesBearerAndPreservesRequest() async throws {
    let transport = StubTransport(replies: [.init(status: 200, body: "result")])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    let body = Data(#"{"url":"https://example.com"}"#.utf8)
    let result = try await client.send(
      .init(
        path: "api/app/captures", method: .post, body: body, query: [.init(name: "q", value: "a b")]
      ))
    XCTAssertEqual(result, Data("result".utf8))
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.host, "notfor.now")
    XCTAssertEqual(request.url?.path, "/api/app/captures")
    XCTAssertEqual(request.url?.query, "q=a%20b")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.httpBody, body)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer original")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    let refreshes = await provider.refreshes
    XCTAssertEqual(refreshes, 0)
  }

  func test401RefreshesOnceAndRetriesWithNewToken() async throws {
    let transport = StubTransport(replies: [.init(status: 401), .init(status: 200, body: "ok")])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    let data = try await client.send(.init(path: "api/app/library"))
    XCTAssertEqual(data, Data("ok".utf8))
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer original")
    XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer refreshed")
    let refreshes = await provider.refreshes
    let endings = await provider.endings
    XCTAssertEqual(refreshes, 1)
    XCTAssertEqual(endings, 0)
  }

  func testConcurrent401ResponsesShareOneRefresh() async throws {
    let provider = StubTokens()
    let transport = ConcurrentUnauthorizedTransport()
    let client = try URLSessionLaterAPIClient(
      baseURL: XCTUnwrap(baseURL), tokenProvider: provider, transport: transport)
    async let first = client.send(LaterAPIRequest(path: "api/app/library"))
    async let second = client.send(LaterAPIRequest(path: "api/app/library"))
    let results = try await [first, second]
    XCTAssertEqual(results, [Data("ok".utf8), Data("ok".utf8)])
    let refreshes = await provider.refreshes
    let count = await transport.count
    XCTAssertEqual(refreshes, 1)
    XCTAssertEqual(count, 4)
  }

  func testSecond401EndsSessionWithoutThirdRequest() async throws {
    let transport = StubTransport(replies: [.init(status: 401), .init(status: 401)])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
    await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
    let requests = await transport.requests
    let refreshes = await provider.refreshes
    let endings = await provider.endings
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(refreshes, 1)
    XCTAssertEqual(endings, 1)
  }

  func test403EndsSessionWithoutRefresh() async throws {
    let transport = StubTransport(replies: [.init(status: 403)])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
    let refreshes = await provider.refreshes
    let endings = await provider.endings
    XCTAssertEqual(refreshes, 0)
    XCTAssertEqual(endings, 1)
  }

  func test403AfterRefreshEndsSession() async throws {
    let transport = StubTransport(replies: [.init(status: 401), .init(status: 403)])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
    let endings = await provider.endings
    XCTAssertEqual(endings, 1)
  }

  func testFailedRefreshEndsSessionWithoutRetry() async throws {
    let transport = StubTransport(replies: [.init(status: 401)])
    let provider = StubTokens(failRefresh: true)
    let client = try makeClient(provider, transport)
    await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
    let requests = await transport.requests
    let endings = await provider.endings
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(endings, 1)
  }

  func testOfflineRefreshDoesNotEndSessionAndNextRequestCanRetry() async throws {
    let transport = StubTransport(replies: [
      .init(status: 401), .init(status: 401), .init(status: 200),
    ])
    let provider = StubTokens()
    await provider.setTransientFailure(true)
    let client = try makeClient(provider, transport)
    do {
      _ = try await client.send(.init(path: "api/app/library"))
      XCTFail("Expected offline refresh failure")
    } catch {
      XCTAssertEqual(error as? URLError, URLError(.notConnectedToInternet))
    }
    let endings = await provider.endings
    let requests = await transport.requests
    XCTAssertEqual(endings, 0)
    XCTAssertEqual(requests.count, 1)
    await provider.setTransientFailure(false)
    _ = try await client.send(.init(path: "api/app/library"))
    let refreshes = await provider.refreshes
    let finalEndings = await provider.endings
    XCTAssertEqual(refreshes, 2)
    XCTAssertEqual(finalEndings, 0)
  }

  func testInvalidTokenNeverReachesTransport() async throws {
    for token in ["", "unsafe\r\nheader"] {
      let provider = StubTokens(token: token)
      let transport = StubTransport(replies: [])
      let client = try makeClient(provider, transport)
      await assertError(.sessionEnded) { _ = try await client.send(.init(path: "api/app/library")) }
      let requests = await transport.requests
      let endings = await provider.endings
      XCTAssertTrue(requests.isEmpty)
      XCTAssertEqual(endings, 1)
    }
  }

  func testDecodesErrorBodyAndHandlesNonJSONError() async throws {
    let cases: [(String, String?)] = [(#"{"error":"not_ready"}"#, "not_ready"), ("not JSON", nil)]
    for (body, expected) in cases {
      let transport = StubTransport(replies: [.init(status: 409, body: body)])
      let provider = StubTokens()
      let client = try makeClient(provider, transport)
      await assertError(.server(status: 409, message: expected)) {
        _ = try await client.send(.init(path: "api/app/library"))
      }
      let endings = await provider.endings
      XCTAssertEqual(endings, 0)
    }
  }

  func testRejectsUntrustedPathsBeforeReadingTokens() async throws {
    let transport = StubTransport(replies: [])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    for path in [
      "", "/api/app", "//evil.test", "https://evil.test", "../secret", "api/../secret",
      "api/%2e%2e/secret", "api\\secret", "api//secret", "api?redirect=evil", "api/#fragment",
    ] {
      await assertError(.invalidURL) { _ = try await client.send(.init(path: path)) }
    }
    let reads = await provider.reads
    let requests = await transport.requests
    XCTAssertEqual(reads, 0)
    XCTAssertTrue(requests.isEmpty)
  }

  func testPreservesConfiguredBasePath() async throws {
    let transport = StubTransport(replies: [.init(status: 204)])
    let client = try URLSessionLaterAPIClient(
      baseURL: XCTUnwrap(URL(string: "https://notfor.now/api/app/")), tokenProvider: StubTokens(),
      transport: transport)
    _ = try await client.send(.init(path: "library"))
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.url?.absoluteString, "https://notfor.now/api/app/library")
  }

  func testRejectsInsecureOrCredentialBearingBaseURL() throws {
    for value in [
      "http://notfor.now", "https://user:password@notfor.now", "https://notfor.now?token=x",
      "https://notfor.now#fragment", "file:///tmp/test",
    ] {
      let url = try XCTUnwrap(URL(string: value))
      XCTAssertThrowsError(
        try URLSessionLaterAPIClient(baseURL: url, tokenProvider: StubTokens())
      ) { error in
        XCTAssertEqual(error as? LaterAPIError, .invalidURL)
      }
    }
  }

  func testTransportFailureDoesNotEndSession() async throws {
    let transport = StubTransport(replies: [])
    let provider = StubTokens()
    let client = try makeClient(provider, transport)
    do {
      _ = try await client.send(.init(path: "api/app/library"))
      XCTFail("Expected transport error")
    } catch {
      XCTAssertEqual(error as? URLError, URLError(.notConnectedToInternet))
    }
    let endings = await provider.endings
    XCTAssertEqual(endings, 0)
  }

  func testRedirectDelegateRejectsSameAndForeignOrigins() throws {
    let original = try XCTUnwrap(baseURL)
    let response = try XCTUnwrap(
      HTTPURLResponse(url: original, statusCode: 302, httpVersion: nil, headerFields: nil))
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let task = session.dataTask(with: original)
    for destination in ["https://notfor.now/login", "https://evil.test/steal"] {
      let request = URLRequest(url: try XCTUnwrap(URL(string: destination)))
      RejectRedirects().urlSession(
        session, task: task, willPerformHTTPRedirection: response, newRequest: request
      ) { redirected in
        XCTAssertNil(redirected)
      }
    }
  }

  private func makeClient(
    _ tokens: StubTokens, _ transport: StubTransport
  ) throws
    -> URLSessionLaterAPIClient
  {
    try URLSessionLaterAPIClient(
      baseURL: XCTUnwrap(baseURL), tokenProvider: tokens, transport: transport)
  }

  private func assertError(
    _ expected: LaterAPIError, operation: () async throws -> Void,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    do {
      try await operation()
      XCTFail("Expected \(expected)", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? LaterAPIError, expected, file: file, line: line)
    }
  }
}

private actor StubTokens: TokenProvider {
  private var token: String
  private let failRefresh: Bool
  private var transientFailure = false
  func setTransientFailure(_ value: Bool) { transientFailure = value }
  private(set) var reads = 0
  private(set) var refreshes = 0
  private(set) var endings = 0

  init(token: String = "original", failRefresh: Bool = false) {
    self.token = token
    self.failRefresh = failRefresh
  }

  func accessToken() async throws -> String {
    reads += 1
    return token
  }

  func refreshToken() async throws -> String {
    refreshes += 1
    if transientFailure { throw URLError(.notConnectedToInternet) }
    if failRefresh { throw LaterAPIError.sessionEnded }
    token = "refreshed"
    return token
  }

  func sessionEnded() async {
    endings += 1
    token = ""
  }
}

private actor StubTransport: LaterHTTPTransport {
  struct Reply: Sendable {
    let status: Int
    var body: String = ""
  }

  private var replies: [Reply]
  private(set) var requests: [URLRequest] = []

  init(replies: [Reply]) {
    self.replies = replies
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    guard !replies.isEmpty else { throw URLError(.notConnectedToInternet) }
    let reply = replies.removeFirst()
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: reply.status, httpVersion: nil, headerFields: nil)
    else {
      throw LaterAPIError.invalidResponse
    }
    return (Data(reply.body.utf8), response)
  }
}

private actor ConcurrentUnauthorizedTransport: LaterHTTPTransport {
  private var firstRequest: CheckedContinuation<Void, Never>?
  private(set) var count = 0

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    count += 1
    let status: Int
    if request.value(forHTTPHeaderField: "Authorization") == "Bearer original" {
      status = 401
      if count == 1 {
        await withCheckedContinuation { firstRequest = $0 }
      } else {
        firstRequest?.resume()
        firstRequest = nil
      }
    } else {
      status = 200
    }
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: nil, headerFields: nil)
    else {
      throw LaterAPIError.invalidResponse
    }
    return (Data("ok".utf8), response)
  }
}
