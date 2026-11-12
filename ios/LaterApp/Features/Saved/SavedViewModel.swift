import Foundation
import LaterKit
import Observation

@MainActor
@Observable
final class SavedViewModel {
  static let offlineNotice = "Offline — showing what you last loaded"
  private(set) var snapshot = SavedSnapshot()
  private(set) var isLoading = false
  private(set) var isSending = false
  private(set) var isOffline = false
  private(set) var message: String?
  let narration: NarrationStore?
  private let service: LibraryService
  private let cache: any SavedCaching
  private let isActive: @MainActor () -> Bool
  private var started = false
  private var requestedCursors: Set<String> = []

  var items: [LibraryItem] { snapshot.items }
  var showEmpty: Bool { snapshot.hasLoaded && items.isEmpty }
  var hasNextPage: Bool { snapshot.nextCursor != nil }
  var pendingCount: Int { snapshot.pending.count }

  init(
    client: any LaterAPIClient, cache: any SavedCaching,
    isActive: @escaping @MainActor () -> Bool = { true }, narration: NarrationStore? = nil
  ) {
    service = LibraryService(client: client)
    self.narration = narration
    self.cache = cache
    self.isActive = isActive
  }

  func start() async {
    guard !started, isActive() else { return }
    started = true
    do {
      if let saved = try cache.read() { snapshot = saved }
    } catch {
      // Do not overwrite a queue that could not be read (for example while protected).
      message = "Couldn't read saved data on this device. Please try again."
      started = false
      return
    }
    await refresh()
  }

  func refresh() async {
    await load(before: nil)
    await retryPending()
  }

  func loadNextPage() async {
    guard let cursor = snapshot.nextCursor, !requestedCursors.contains(cursor) else { return }
    await load(before: cursor)
  }

  func reconnect() async {
    if !started {
      await start()
    } else if isOffline {
      await refresh()
    } else {
      await retryPending()
    }
  }

  private func load(before cursor: String?) async {
    guard started, !isLoading, isActive() else { return }
    isLoading = true
    message = nil
    defer { isLoading = false }
    do {
      let page = try await service.page(before: cursor)
      guard isActive(), !Task.isCancelled else { return }
      if let cursor { requestedCursors.insert(cursor) } else { requestedCursors.removeAll() }
      var seen: Set<UUID> = []
      // The refreshed page replaces earlier pages; paging never prefetches unseen pages.
      let combined = cursor == nil ? page.items : snapshot.items + page.items
      snapshot.items = combined.filter { seen.insert($0.id).inserted }.sorted {
        ($0.savedDate ?? .distantPast) > ($1.savedDate ?? .distantPast)
      }
      snapshot.nextCursor = page.nextCursor.flatMap { requestedCursors.contains($0) ? nil : $0 }
      snapshot.hasLoaded = true
      narration?.enqueueNewest(snapshot.items)
      isOffline = false
      do { try cache.write(snapshot) } catch {
        message = "Couldn't keep this library offline. Please try again."
      }
    } catch {
      guard isActive(), !Task.isCancelled else { return }
      isOffline = Self.isNetworkFailure(error)
      message = isOffline ? nil : "Couldn't load Saved. Please try again."
    }
  }

  /// Persist the request ID before sending. A timeout may mean the server already applied it.
  func perform(_ kind: PendingItemAction.Kind, on item: LibraryItem) async -> URL? {
    guard started, isActive(), !isSending else { return nil }
    message = nil
    let action =
      snapshot.pending.first { $0.captureId == item.id && $0.action == kind }
      ?? PendingItemAction(captureId: item.id, action: kind)
    if !snapshot.pending.contains(action) {
      var next = snapshot
      next.pending.append(action)
      do {
        try cache.write(next)
        snapshot = next
      } catch {
        message = "Couldn't save this action on this device. Please try again."
        return nil
      }
    }
    isSending = true
    defer { isSending = false }
    return await send(action)
  }

  func retryPending() async {
    guard started, isActive(), !isSending, !snapshot.pending.isEmpty else { return }
    isSending = true
    defer { isSending = false }
    for action in snapshot.pending {
      _ = await send(action)
      // Stop on transient failure; preserve this and later IDs for the next attempt.
      if !isActive() || snapshot.pending.contains(action) { break }
    }
  }

  private func send(_ action: PendingItemAction) async -> URL? {
    do {
      let result = try await service.perform(action)
      guard isActive(), !Task.isCancelled else { return nil }
      try removePending(action)
      isOffline = false
      message = action.action == .consume ? "Marked done." : "Original is ready to open."
      return result.safeDestination
    } catch {
      guard isActive(), !Task.isCancelled else { return nil }
      if case .server(status: 409, message: _) = error as? LaterAPIError {
        do { try removePending(action) } catch {
          message = "Couldn't update saved actions. Please try again."
          return nil
        }
        message = "This original isn't available."
      } else if Self.isNetworkFailure(error) {
        isOffline = true
        message = "Action saved on this device. We'll send it when you're online."
      } else {
        message = "Couldn't finish this action. Please try again."
      }
      return nil
    }
  }

  private func removePending(_ action: PendingItemAction) throws {
    var next = snapshot
    next.pending.removeAll { $0.id == action.id }
    try cache.write(next)
    snapshot = next
  }

  static func isNetworkFailure(_ error: any Error) -> Bool {
    guard let error = error as? URLError else { return false }
    return [
      .notConnectedToInternet, .networkConnectionLost, .timedOut,
      .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
    ].contains(error.code)
  }
}

extension LibraryItem {
  var displaySource: String { nonempty(source) ?? "Saved item" }
  var displayDate: String {
    guard let savedDate else { return "date unavailable" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_AU")
    formatter.dateStyle = .medium
    return formatter.string(from: savedDate)
  }
  var displayTitle: String { nonempty(title) ?? "\(displaySource) · saved \(displayDate)" }
  var statusLabel: String {
    switch listen.state {
    case .narratable: "Can be narrated"
    case .preparing: "Preparing…"
    case .openOriginal: "Open original"
    }
  }
  var reasonLabel: String? {
    guard listen.state == .openOriginal else { return nil }
    if kind == "video" { return "Video" }
    if kind == "post" { return "Social post" }
    switch listen.reason ?? .unknown {
    case .paywalled: return "Behind a paywall"
    case .truncated: return "Only part of the text was available"
    case .notAnArticle, .notHTML: return "Not an article"
    case .tooShort, .extractionFailed, .fetchFailed, .noSource, .unknown:
      return "Couldn't read this page"
    }
  }
  var accessibilitySummary: String {
    [displayTitle, displaySource, "Saved \(displayDate)", statusLabel, reasonLabel]
      .compactMap { $0 }.joined(separator: ", ")
  }

  private func nonempty(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }
    return value
  }
}
