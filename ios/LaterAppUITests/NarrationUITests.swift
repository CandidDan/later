import XCTest

final class NarrationUITests: XCTestCase {
  @MainActor
  func testReadyDurationAndAttribution() {
    let app = launch()
    let row = app.buttons["saved.item.00000000-0000-4000-8000-000000000001"]
    let ready = NSPredicate(format: "label CONTAINS %@", "Ready to listen · 1 min")
    expectation(for: ready, evaluatedWith: row)
    waitForExpectations(timeout: 10)
    row.tap()
    XCTAssertTrue(
      app.staticTexts["Narrated by Later with an iPhone voice · Source: Example"].exists)
    XCTAssertFalse(app.buttons["saved.detail.prepare"].exists)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.lifetime = .keepAlways
    add(capture)
  }

  @MainActor
  func testConflictExplainsOpenOriginalWithoutAudio() {
    let app = launch(extra: ["--narration-conflict"])
    let row = app.buttons["saved.item.00000000-0000-4000-8000-000000000001"]
    let unavailable = NSPredicate(format: "label CONTAINS %@", "Behind a paywall")
    expectation(for: unavailable, evaluatedWith: row)
    waitForExpectations(timeout: 10)
    XCTAssertTrue(row.label.contains("Open original"))
    row.tap()
    XCTAssertTrue(app.staticTexts["Behind a paywall"].exists)
    XCTAssertFalse(app.buttons["saved.detail.prepare"].exists)
    XCTAssertTrue(app.buttons["saved.detail.open"].exists)
  }

  @MainActor
  private func launch(extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments =
      ["--uitesting-auth", "--auth-signed-in", "--uitesting-library", "--uitesting-narration"]
      + extra
    app.launch()
    let saved = app.tabBars.buttons["Saved"]
    XCTAssertTrue(saved.waitForExistence(timeout: 10))
    saved.tap()
    return app
  }
}
