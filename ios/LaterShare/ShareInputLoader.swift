import Foundation
import UniformTypeIdentifiers

struct ShareInput: Equatable, Sendable {
  let url: String?
  let text: String?

  var preview: String { url ?? text ?? "" }
}

enum ShareInputError: LocalizedError {
  case unsupported, multipleItems, unreadable

  var errorDescription: String? {
    switch self {
    case .unsupported: "Share a web link or plain text with Later."
    case .multipleItems: "Share one item at a time."
    case .unreadable: "Couldn't read this share. Please try again."
    }
  }
}

/// Reads only declared URL or plain-text representations; never opens a shared file URL.
@MainActor
enum ShareInputLoader {
  static func load(items: [NSExtensionItem]) async throws -> ShareInput {
    let providers = items.flatMap { $0.attachments ?? [] }
    guard !providers.isEmpty else { throw ShareInputError.unsupported }
    // Do not silently discard attachments. A provider may advertise both URL and text;
    // those are two representations of one item, so prefer its URL representation.
    guard providers.count == 1, let provider = providers.first else {
      throw ShareInputError.multipleItems
    }
    let isURL = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
    let type = isURL ? UTType.url.identifier : UTType.plainText.identifier
    guard provider.hasItemConformingToTypeIdentifier(type) else {
      throw ShareInputError.unsupported
    }
    try Task.checkCancellation()
    let value: String = try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
        if error != nil {
          continuation.resume(throwing: ShareInputError.unreadable)
        } else if isURL, let url = item as? URL {
          continuation.resume(returning: url.absoluteString)
        } else if let string = item as? String {
          continuation.resume(returning: string)
        } else if !isURL, let data = item as? Data,
          let string = String(data: data, encoding: .utf8)
        {
          continuation.resume(returning: string)
        } else {
          continuation.resume(throwing: ShareInputError.unreadable)
        }
      }
    }
    try Task.checkCancellation()
    return ShareInput(url: isURL ? value : nil, text: isURL ? nil : value)
  }
}
