import XCTest

final class ShellUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTabsShowHonestEmptyStates() {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth", "--auth-signed-in"]
    app.launch()

    let tabs = app.tabBars.firstMatch
    XCTAssertTrue(tabs.waitForExistence(timeout: 10))
    XCTAssertEqual(tabs.buttons.count, 2, "v1 has exactly two tabs")

    for (tab, identifier) in [("Listen", "listen.empty"), ("Saved", "saved.empty")] {
      let button = tabs.buttons[tab]
      XCTAssertTrue(button.exists, "\(tab) tab is missing")
      button.tap()

      let state = app.descendants(matching: .any)[identifier]
      XCTAssertTrue(state.waitForExistence(timeout: 5), "\(tab) shows no empty state")
      XCTAssertTrue(state.label.contains("Nothing to"), "\(tab) says: \(state.label)")

      XCTAssertEqual(app.cells.count, 0, "\(tab) shows list rows")
      XCTAssertEqual(app.tables.count, 0, "\(tab) shows a list")
      XCTAssertEqual(app.collectionViews.count, 0, "\(tab) shows a list")
    }
  }

  @MainActor
  func testAboutShowsVersionAndCloses() {
    let app = XCUIApplication()
    app.launchArguments = ["--uitesting-auth", "--auth-signed-in"]
    app.launch()

    app.buttons["about.open"].firstMatch.tap()
    let version = app.staticTexts["about.version"]
    XCTAssertTrue(version.waitForExistence(timeout: 5))
    XCTAssertTrue(version.label.hasPrefix("Version "), version.label)
    XCTAssertFalse(version.label.contains("Unknown"), version.label)

    app.buttons["about.done"].tap()
    XCTAssertTrue(version.waitForNonExistence(timeout: 5))
  }
}
