import XCTest

final class ListenUITests: XCTestCase {
  @MainActor
  func testChoicesPreviewAndPlayIntoPlayer() {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "--uitesting-auth", "--auth-signed-in", "--uitesting-library", "--uitesting-narration",
    ]
    app.launch()
    XCTAssertTrue(app.buttons["listen.slot.15"].waitForExistence(timeout: 20))
    let play = app.buttons["listen.play"]
    let enabled = NSPredicate(format: "enabled == true")
    expectation(for: enabled, evaluatedWith: play)
    waitForExpectations(timeout: 20)
    for slot in [10, 15, 30] {
      app.buttons["listen.slot.\(slot)"].tap()
      XCTAssertTrue(app.staticTexts["listen.summary"].exists)
      XCTAssertTrue(app.staticTexts["A quiet morning"].exists)
    }
    XCTAssertFalse(app.staticTexts["player.title"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.lifetime = .keepAlways
    add(screenshot)
    play.tap()
    XCTAssertTrue(app.staticTexts["player.title"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["player.title"].label, "A quiet morning")
  }
}
