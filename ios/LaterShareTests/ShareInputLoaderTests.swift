import Foundation
import LaterKit
import UniformTypeIdentifiers
import XCTest

@MainActor
final class ShareInputLoaderTests: XCTestCase {
  func testLoadsURLRepresentation() async throws {
    let provider = NSItemProvider(
      item: NSURL(string: "https://example.com/article")!, typeIdentifier: UTType.url.identifier)
    let input = try await ShareInputLoader.load(items: [item(provider)])
    XCTAssertEqual(input.url, "https://example.com/article")
    XCTAssertNil(input.text)
    XCTAssertEqual(input.preview, input.url)
  }

  func testLoadsPlainTextWithoutTrimmingContent() async throws {
    let provider = NSItemProvider(
      item: " Read this\n" as NSString, typeIdentifier: UTType.plainText.identifier)
    let input = try await ShareInputLoader.load(items: [item(provider)])
    XCTAssertEqual(input.text, " Read this\n")
    XCTAssertNil(input.url)
  }

  func testFileURLIsNotOpenedAndFailsCaptureValidation() async throws {
    let provider = NSItemProvider(
      item: NSURL(fileURLWithPath: "/private/secret"), typeIdentifier: UTType.url.identifier)
    let input = try await ShareInputLoader.load(items: [item(provider)])
    XCTAssertNotNil(CaptureRequest(url: input.url).validationMessage)
  }

  func testRejectsEmptyUnsupportedAndMultipleItems() async {
    let text = NSItemProvider(item: "text" as NSString, typeIdentifier: UTType.plainText.identifier)
    for items in [[], [item(NSItemProvider())], [item(text), item(text)]] {
      do {
        _ = try await ShareInputLoader.load(items: items)
        XCTFail("Must not silently accept missing or multiple content")
      } catch {
        XCTAssertTrue(error is ShareInputError)
      }
    }
  }

  func testProviderFailureIsReportedWithoutPrivateErrorDetails() async {
    let provider = NSItemProvider()
    provider.registerItem(forTypeIdentifier: UTType.plainText.identifier) { completion, _, _ in
      completion?(nil, NSError(domain: "private-file-path", code: 1))
    }
    do {
      _ = try await ShareInputLoader.load(items: [item(provider)])
      XCTFail("Expected provider failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Couldn't read this share. Please try again.")
    }
  }

  private func item(_ provider: NSItemProvider) -> NSExtensionItem {
    let item = NSExtensionItem()
    item.attachments = [provider]
    return item
  }
}
