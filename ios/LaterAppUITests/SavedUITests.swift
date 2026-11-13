import XCTest

final class SavedUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  @MainActor
  func testSavedRowsDetailAndConfirmedConsume() {
    let app = launch()
    let row = app.buttons["saved.item.00000000-0000-4000-8000-000000000001"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.label.contains("A quiet morning"))
    XCTAssertTrue(row.label.contains("Example"))
    XCTAssertTrue(row.label.contains("Can be narrated"))
    XCTAssertFalse(row.label.contains("~"))
    row.tap()
    XCTAssertTrue(app.staticTexts["saved.detail.title"].waitForExistence(timeout: 5))
    let detailCapture = XCTAttachment(screenshot: app.screenshot())
    detailCapture.lifetime = .keepAlways
    add(detailCapture)
    XCTAssertTrue(app.staticTexts["Sam"].exists)
    XCTAssertTrue(app.buttons["saved.detail.open"].exists)
    app.buttons["saved.detail.consume"].tap()
    XCTAssertTrue(app.buttons["Mark done"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    XCTAssertFalse(app.staticTexts["Marked done."].exists)
    app.buttons["saved.detail.consume"].tap()
    app.buttons["Mark done"].tap()
    let message = app.staticTexts["saved.detail.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    XCTAssertEqual(message.label, "Marked done.")
    app.buttons["saved.detail.close"].tap()
    XCTAssertTrue(row.waitForExistence(timeout: 5))
  }

  @MainActor
  func testUnavailableOriginalStaysInDetail() {
    let app = launch(extra: ["--saved-unavailable"])
    let row = app.buttons["saved.item.00000000-0000-4000-8000-000000000002"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.label.contains("Video"))
    row.tap()
    app.buttons["saved.detail.open"].tap()
    let message = app.staticTexts["saved.detail.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    XCTAssertEqual(message.label, "This original isn't available.")
    XCTAssertTrue(app.buttons["saved.detail.close"].exists)
  }

  @MainActor
  func testOfflineWithoutCacheDoesNotClaimEmptyLibrary() {
    let app = launch(extra: ["--saved-offline"])
    XCTAssertTrue(app.staticTexts["saved.offline"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["saved.empty"].exists)
    XCTAssertTrue(app.buttons["saved.retry"].exists)
  }

  @MainActor
  func testLargestDynamicTypeKeepsDetailActionsReachable() {
    let app = launch(extra: [
      "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
    ])
    let row = app.buttons["saved.item.00000000-0000-4000-8000-000000000001"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.isHittable)
    row.tap()
    let action = app.buttons["saved.detail.consume"]
    for _ in 0..<6 {
      if action.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(action.isHittable)
    let largeTextCapture = XCTAttachment(screenshot: app.screenshot())
    largeTextCapture.lifetime = .keepAlways
    add(largeTextCapture)
    action.tap()
    XCTAssertTrue(app.buttons["Mark done"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["saved.detail.close"].isHittable)
  }

  @MainActor
  func testSignedOutShareRequiresAccountConfirmation() {
    let app = launch(extra: ["--uitesting-unassigned-share"])
    let assign = app.buttons["saved.assign-shares"]
    XCTAssertTrue(assign.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["You shared 1 item while signed out."].exists)
    assign.tap()
    let alert = app.alerts["Save these shared items?"]
    XCTAssertTrue(alert.waitForExistence(timeout: 5))
    XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Save 1 item to tester@later.invalid?")).firstMatch.exists)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "Confirm account for signed-out share"
    capture.lifetime = .keepAlways
    add(capture)
    alert.buttons["Cancel"].tap()
    XCTAssertTrue(assign.exists, "Cancelling must preserve the unassigned item")
    assign.tap()
    alert.buttons["Save to this account"].tap()
    XCTAssertTrue(assign.waitForNonExistence(timeout: 10), "Successful assignment and delivery clear the pending banner")
    XCTAssertFalse(app.staticTexts["saved.capture-notice"].exists)
  }

  @MainActor
  private func launch(extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth", "--auth-signed-in", "--uitesting-library"] + extra
    app.launch()
    let saved = app.tabBars.buttons["Saved"]
    XCTAssertTrue(saved.waitForExistence(timeout: 10))
    saved.tap()
    return app
  }
}
