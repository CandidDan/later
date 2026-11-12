import Foundation

public enum ListenState: String, Codable, Sendable {
  case narratable
  case preparing
  case openOriginal = "open_original"
}

public enum OpenOriginalReason: String, Codable, CaseIterable, Sendable {
  case notAnArticle = "not_an_article"
  case paywalled
  case truncated
  case tooShort = "too_short"
  case notHTML = "not_html"
  case extractionFailed = "extraction_failed"
  case fetchFailed = "fetch_failed"
  case noSource = "no_source"
  case unknown
}

/// Unknown contract values never turn into a promise that Later can narrate an item.
public struct LibraryListen: Codable, Equatable, Sendable {
  public let state: ListenState
  public let reason: OpenOriginalReason?
  public let wordCount: Int?
  public let textVersion: String?

  private enum CodingKeys: String, CodingKey {
    case state, reason, wordCount, textVersion
  }

  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let rawState = try values.decode(String.self, forKey: .state)
    let rawReason = try values.decodeIfPresent(String.self, forKey: .reason)
    let knownState = ListenState(rawValue: rawState)
    let knownReason = rawReason.flatMap(OpenOriginalReason.init(rawValue:))
    if knownState == nil || (rawReason != nil && knownReason == nil) {
      state = .openOriginal
      reason = .unknown
      wordCount = nil
      textVersion = nil
    } else {
      state = knownState ?? .openOriginal
      reason = state == .openOriginal ? (knownReason ?? .unknown) : nil
      wordCount = try values.decodeIfPresent(Int.self, forKey: .wordCount)
      textVersion = try values.decodeIfPresent(String.self, forKey: .textVersion)
    }
  }
}

public struct LibraryItem: Codable, Equatable, Identifiable, Sendable {
  public var id: UUID { captureId }
  public let captureId: UUID
  public let title: String?
  public let creator: String?
  public let source: String?
  public let sourceUrl: String?
  public let savedAt: String
  public let kind: String
  public let listen: LibraryListen

  public var savedDate: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: savedAt) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: savedAt)
  }
}

public struct LibraryPage: Codable, Equatable, Sendable {
  public let items: [LibraryItem]
  /// An opaque server cursor. Never derive a cursor from client dates or IDs.
  public let nextCursor: String?
}

public struct PendingItemAction: Codable, Equatable, Identifiable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case open, consume
  }
  public var id: UUID { requestId }
  public let requestId: UUID
  public let captureId: UUID
  public let action: Kind

  public init(captureId: UUID, action: Kind, requestId: UUID = UUID()) {
    self.captureId = captureId
    self.action = action
    self.requestId = requestId
  }
}

public struct ItemActionResult: Decodable, Sendable {
  public let status: String
  public let destination: String?

  public var safeDestination: URL? {
    guard let destination, let url = URL(string: destination),
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      let host = url.host, !host.isEmpty, url.user == nil, url.password == nil
    else { return nil }
    return url
  }
}

public struct LibraryService: Sendable {
  private let client: any LaterAPIClient

  public init(client: any LaterAPIClient) { self.client = client }

  public func page(before cursor: String? = nil) async throws -> LibraryPage {
    var query = [URLQueryItem(name: "limit", value: "30")]
    if let cursor { query.append(URLQueryItem(name: "before", value: cursor)) }
    let data = try await client.send(LaterAPIRequest(path: "api/app/library", query: query))
    return try JSONDecoder().decode(LibraryPage.self, from: data)
  }

  public func perform(_ action: PendingItemAction) async throws -> ItemActionResult {
    struct Body: Encodable {
      let requestId: UUID
      let action: PendingItemAction.Kind
    }
    let body = try JSONEncoder().encode(Body(requestId: action.requestId, action: action.action))
    let data = try await client.send(
      LaterAPIRequest(
        path: "api/revisit/actions/\(action.captureId.uuidString)", method: .post, body: body))
    let result = try JSONDecoder().decode(ItemActionResult.self, from: data)
    guard result.status == "applied" else {
      throw LaterAPIError.server(status: 409, message: nil)
    }
    if action.action == .open && result.safeDestination == nil {
      throw LaterAPIError.server(status: 409, message: nil)
    }
    return result
  }
}
