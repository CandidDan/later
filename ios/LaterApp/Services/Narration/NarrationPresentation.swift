import Foundation
import LaterKit

extension NarrationStore {
  func statusLabel(for item: LaterKit.LibraryItem) -> String {
    if snapshot.conflicts[item.id] != nil { return "Open original" }
    if let manifest = manifest(for: item) {
      return "Ready to listen · \(max(1, Int(ceil(manifest.duration / 60)))) min"
    }
    if preparing == item.id || snapshot.pending.contains(where: { $0.id == item.id }) {
      return "Preparing audio…"
    }
    return item.statusLabel
  }

  func reasonLabel(for item: LaterKit.LibraryItem) -> String? {
    guard let reason = snapshot.conflicts[item.id] else { return item.reasonLabel }
    switch reason {
    case .paywalled: return "Behind a paywall"
    case .truncated: return "Only part of the text was available"
    case .notAnArticle, .notHTML: return "Not an article"
    default: return "Couldn't read this page"
    }
  }
}
