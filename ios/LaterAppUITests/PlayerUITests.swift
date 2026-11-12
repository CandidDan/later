import XCTest

final class PlayerUITests: XCTestCase {
  @MainActor
  func testTwoItemPlayerControlsScrubberQueueAndExplicitConsume() {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "--uitesting-auth", "--auth-signed-in", "--uitesting-library", "--uitesting-narration",
      "--uitesting-player",
    ]
    app.launch()
    let mini = app.buttons["player.mini.open"]
    XCTAssertTrue(mini.waitForExistence(timeout: 20))
    mini.tap()
    XCTAssertTrue(app.staticTexts["player.title"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["player.title"].label, "A quiet morning")
    XCTAssertTrue(app.sliders["player.scrubber"].exists)
    XCTAssertTrue(app.staticTexts["A second thought"].exists)
    let toggle = app.buttons["player.toggle"]
    XCTAssertEqual(toggle.label, "Play")
    toggle.tap()
    XCTAssertEqual(toggle.label, "Pause")
    toggle.tap()
    XCTAssertEqual(toggle.label, "Play")
    app.buttons["Forward 30 seconds"].tap()
    app.buttons["Next"].tap()
    XCTAssertEqual(app.staticTexts["player.title"].label, "A second thought")
    app.buttons["Previous"].tap()
    XCTAssertEqual(app.staticTexts["player.title"].label, "A quiet morning")
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.lifetime = .keepAlways
    add(capture)
    let consume = app.buttons["player.consume"]
    for _ in 0..<5 { if consume.isHittable { break }; app.swipeUp() }
    XCTAssertTrue(consume.isHittable)
    consume.tap()
    XCTAssertTrue(app.buttons["Mark done"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    XCTAssertFalse(app.staticTexts["Marked done."].exists)
    consume.tap()
    app.buttons["Mark done"].tap()
    XCTAssertTrue(app.staticTexts["Marked done."].waitForExistence(timeout: 5))
  }
}
