import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum NarrationError: Error, Equatable, Sendable {
  case openOriginal(OpenOriginalReason)
  case invalidText
}

/// Preserve narration's typed 409 reason before the general API client's error-message mapping.
/// The normal client still owns authentication, refresh, redirects and URL validation.
public struct NarrationHTTPTransport: LaterHTTPTransport {
  private let underlying: any LaterHTTPTransport
  public init(underlying: any LaterHTTPTransport = URLSessionLaterHTTPTransport()) {
    self.underlying = underlying
  }

  public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await underlying.data(for: request)
    if response.statusCode == 409 {
      struct Conflict: Decodable { let reason: String? }
      let body = try? JSONDecoder().decode(Conflict.self, from: data)
      throw NarrationError.openOriginal(
        body?.reason.flatMap(OpenOriginalReason.init(rawValue:)) ?? .unknown)
    }
    return (data, response)
  }
}

public struct NarrationService: Sendable {
  private let client: any LaterAPIClient
  public init(client: any LaterAPIClient) { self.client = client }

  /// This endpoint records exposure before returning text. No alternative content source exists.
  public func text(for id: UUID) async throws -> NarrationText {
    do {
      let data = try await client.send(LaterAPIRequest(path: "api/app/narrations/\(id.uuidString)"))
      let value = try JSONDecoder().decode(NarrationText.self, from: data)
      guard value.captureId == id, !value.textVersion.isEmpty, !value.paragraphs.isEmpty,
        value.paragraphs.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
      else { throw NarrationError.invalidText }
      return value
    } catch LaterAPIError.server(status: 409, message: _) {
      throw NarrationError.openOriginal(.unknown)
    }
  }
}
