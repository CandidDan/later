import Foundation
import LaterKit
import Network

@MainActor
enum SavedServiceFactory {
  static func make(auth: AuthService) throws -> SavedViewModel {
    guard let userID = auth.session?.user.id else { throw LaterAPIError.sessionEnded }
    let generation = auth.sessionGeneration
    let active = { @MainActor [weak auth] in
      auth?.session?.user.id == userID && auth?.sessionGeneration == generation
    }
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--uitesting-auth") {
        let narration: NarrationStore?
        if ProcessInfo.processInfo.arguments.contains("--uitesting-narration") {
          narration = try NarrationStore(
            client: SavedTestSupport.Client(), renderer: NarrationUITestRenderer(),
            files: NarrationFiles(userID: userID, parent: FileManager.default.temporaryDirectory),
            isActive: active)
        } else {
          narration = nil
        }
        return SavedViewModel(
          client: SavedTestSupport.Client(), cache: SavedTestSupport.Cache(), isActive: active,
          narration: narration)
      }
    #endif
    let configuration = try AppAuthConfiguration(info: Bundle.main.infoDictionary ?? [:])
    let parent = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
    let narrationClient = try URLSessionLaterAPIClient(
      baseURL: configuration.apiBaseURL, tokenProvider: auth, transport: NarrationHTTPTransport())
    let narration = try NarrationStore(
      client: narrationClient, renderer: DeviceNarrationRenderer(),
      files: NarrationFiles(userID: userID, parent: parent), isActive: active)
    return SavedViewModel(
      client: try URLSessionLaterAPIClient(baseURL: configuration.apiBaseURL, tokenProvider: auth),
      cache: SavedFileCache(userID: userID, parent: parent), isActive: active, narration: narration)
  }
}

enum SavedConnectivity {
  static func updates() -> AsyncStream<Bool> {
    AsyncStream { continuation in
      let monitor = NWPathMonitor()
      monitor.pathUpdateHandler = { path in continuation.yield(path.status == .satisfied) }
      continuation.onTermination = { _ in monitor.cancel() }
      monitor.start(queue: DispatchQueue(label: "later.saved.connectivity"))
    }
  }
}

#if DEBUG && targetEnvironment(simulator)
  /// Simulator UI fixtures are excluded from device and release builds.
  enum SavedTestSupport {
    struct Client: LaterAPIClient {
      func send(_ request: LaterAPIRequest) async throws -> Data {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--saved-offline") { throw URLError(.notConnectedToInternet) }
        if request.path.hasPrefix("api/app/narrations/") {
          if args.contains("--narration-conflict") { throw NarrationError.openOriginal(.paywalled) }
          return try JSONSerialization.data(withJSONObject: [
            "captureId": request.path.split(separator: "/").last.map(String.init) ?? "",
            "textVersion": "fixture", "title": "A quiet morning", "siteName": "Example",
            "sourceUrl": "https://example.org/article", "intro": "Narrated by Later.",
            "paragraphs": ["The complete article."], "outro": "End of A quiet morning.",
            "wordCount": 3,
          ])
        }
        if request.method == .post {
          if args.contains("--saved-unavailable") {
            throw LaterAPIError.server(status: 409, message: nil)
          }
          return Data(#"{"status":"applied","destination":"https://example.org/article"}"#.utf8)
        }
        if !args.contains("--uitesting-library") {
          return Data(#"{"items":[],"nextCursor":null}"#.utf8)
        }
        return Data(
          #"{"items":[{"captureId":"00000000-0000-4000-8000-000000000001","title":"A quiet morning","creator":"Sam","source":"Example","sourceUrl":"https://example.org/article","savedAt":"2026-11-12T12:00:00Z","kind":"article","listen":{"state":"narratable","wordCount":500,"textVersion":"fixture"}},{"captureId":"00000000-0000-4000-8000-000000000002","title":"A long video","creator":null,"source":"YouTube","sourceUrl":"https://youtube.com/watch?v=fixture","savedAt":"2026-11-11T12:00:00Z","kind":"video","listen":{"state":"open_original","reason":"not_an_article"}}],"nextCursor":null}"#
            .utf8)
      }
    }

    @MainActor
    final class Cache: SavedCaching {
      private var value: SavedSnapshot?
      func read() -> SavedSnapshot? { value }
      func write(_ snapshot: SavedSnapshot) { value = snapshot }
    }
  }
#endif
