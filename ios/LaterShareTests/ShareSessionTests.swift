import Foundation
import LaterKit
import XCTest

@MainActor
final class ShareSessionTests: XCTestCase {
  private let owner = UUID()

  func testUsesCurrentCredentialForBoundOwner() async throws {
    let data = session(owner: owner)
    let provider = ShareTokenProvider(ownerID: owner, readSession: { data })
    let token = try await provider.accessToken()
    XCTAssertEqual(token, "current-token")
  }

  func testMissingChangedExpiredAndMalformedSessionsCannotSend() async {
    let invalid: [Data?] = [
      nil, session(owner: UUID()), session(owner: owner, expiry: 1),
      Data("invalid".utf8), session(owner: owner, token: ""),
    ]
    for data in invalid {
      let provider = ShareTokenProvider(ownerID: owner, readSession: { data })
      do {
        _ = try await provider.accessToken()
        XCTFail("Invalid or different account must not deliver the share")
      } catch {
        XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
      }
    }
  }

  func testCredentialIsReadAgainAfterRefreshAccountSwitchAndSignOut() async throws {
    let storage = MutableShareCredential(session(owner: owner))
    let provider = ShareTokenProvider(ownerID: owner, readSession: { storage.read() })
    let first = try await provider.accessToken()
    XCTAssertEqual(first, "current-token")
    storage.set(session(owner: owner, token: "refreshed-token"))
    let refreshed = try await provider.accessToken()
    XCTAssertEqual(refreshed, "refreshed-token")
    for replacement in [session(owner: UUID()), nil] {
      storage.set(replacement)
      do {
        _ = try await provider.accessToken()
        XCTFail("An existing sheet must reject a changed or removed account")
      } catch {
        XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
      }
    }
  }

  func testRefreshDoesNotReuseRejectedCredential() async {
    let data = session(owner: owner)
    let provider = ShareTokenProvider(ownerID: owner, readSession: { data })
    do {
      _ = try await provider.refreshToken()
      XCTFail("The app owns refresh")
    } catch {
      XCTAssertEqual(error as? LaterAPIError, .sessionEnded)
    }
    await provider.sessionEnded()
    // Ending extension delivery leaves the shared credential intact for the app.
    let token = try? await provider.accessToken()
    XCTAssertEqual(token, "current-token")
  }

  private func session(
    owner: UUID, expiry: TimeInterval = 4_000_000_000, token: String = "current-token"
  ) -> Data {
    try! JSONSerialization.data(withJSONObject: [
      "access_token": token, "expires_at": expiry, "user": ["id": owner.uuidString],
    ])
  }
}

/// Synchronous Keychain reads may occur on any executor.
private final class MutableShareCredential: @unchecked Sendable {
  private let lock = NSLock()
  private var data: Data?

  init(_ data: Data?) { self.data = data }

  func read() -> Data? {
    lock.lock()
    defer { lock.unlock() }
    return data
  }

  func set(_ value: Data?) {
    lock.lock()
    defer { lock.unlock() }
    data = value
  }
}
