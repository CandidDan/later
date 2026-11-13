import Foundation

/// The wire payload deliberately contains no account identifier. The server owns attribution.
public struct CaptureRequest: Codable, Equatable, Sendable {
  public let requestId: UUID
  public let url: String?
  public let text: String?
  public let note: String?
  public let sharedAt: String

  public init(
    requestId: UUID = UUID(), url: String? = nil, text: String? = nil,
    note: String? = nil, sharedAt: Date = Date()
  ) {
    self.requestId = requestId
    self.url = url
    self.text = text
    self.note = note
    self.sharedAt = ISO8601DateFormatter().string(from: sharedAt)
  }

  /// JavaScript's string limits count UTF-16 code units, not Swift Characters or UTF-8 bytes.
  public var validationMessage: String? {
    if let url {
      guard url.utf16.count <= 2000,
        !url.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
        let parsed = URLComponents(string: url),
        ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
        let host = parsed.host, !host.isEmpty
      else { return "Choose a valid http or https link of at most 2,000 characters." }
    }
    if let text, text.utf16.count > 16000 { return "Text must be at most 16,000 characters." }
    if let note, note.utf16.count > 16000 { return "Your note must be at most 16,000 characters." }
    if url == nil && (text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) {
      return "Choose a link or some text to save."
    }
    guard ISO8601DateFormatter().date(from: sharedAt) != nil else {
      return "The share date is invalid."
    }
    guard let data = try? JSONEncoder().encode(self), data.count <= 64 * 1024 else {
      return "This share is too large. Shorten the text or note."
    }
    return nil
  }

  public func encodedBody() throws -> Data {
    if let message = validationMessage { throw CaptureValidationError(message: message) }
    return try JSONEncoder().encode(self)
  }
}

public struct CaptureValidationError: Error, Equatable, Sendable {
  public let message: String
}

/// Account binding is local metadata, never sent to the capture API. A nil owner requires the
/// app to obtain explicit confirmation before assigning a signed-out share to an account.
public struct PendingCapture: Codable, Equatable, Sendable {
  public let request: CaptureRequest
  public let ownerID: UUID?

  public init(request: CaptureRequest, ownerID: UUID?) {
    self.request = request
    self.ownerID = ownerID
  }
}
