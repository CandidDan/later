import XCTest

final class AuthUITests: XCTestCase {
  @MainActor
  func testSignedOutShowsSignIn() {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth"]
    app.launch()
    XCTAssertTrue(app.textFields["auth.email"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    XCTAssertTrue(app.buttons["auth.submit"].exists)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "Signed-out sign-in screen"
    capture.lifetime = .keepAlways
    add(capture)
  }

  @MainActor
  func testEmailSubmissionAndCallbackShowSignedInShell() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth"]
    app.launch()
    let email = app.textFields["auth.email"]
    XCTAssertTrue(email.waitForExistence(timeout: 10))
    email.tap()
    email.typeText("tester@later.invalid\n")
    XCTAssertTrue(app.descendants(matching: .any)["auth.checkEmail"].waitForExistence(timeout: 5))
    app.open(try XCTUnwrap(URL(string: "later://auth-callback?code=ui-test")))
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    app.buttons["about.open"].firstMatch.tap()
    XCTAssertEqual(app.staticTexts["about.email"].label, "tester@later.invalid")
    app.buttons["about.signOut"].tap()
    XCTAssertTrue(app.textFields["auth.email"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    XCTAssertFalse(app.staticTexts["about.email"].exists)
  }

  @MainActor
  func testUnknownAccountErrorDoesNotRevealAccountState() {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth", "--auth-error"]
    app.launch()
    let email = app.textFields["auth.email"]
    XCTAssertTrue(email.waitForExistence(timeout: 10))
    email.tap()
    email.typeText("unknown@later.invalid\n")
    let error = app.staticTexts["auth.error"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertEqual(error.label, "We couldn't sign you in. Please try again.")
    XCTAssertFalse(app.tabBars.firstMatch.exists)
  }
}
