import XCTest

@testable import LaterKit

final class AppInfoTests: XCTestCase {
  func testReadsVersionAndBuildFromInfoDictionary() {
    let info = AppInfo(infoDictionary: [
      "CFBundleShortVersionString": "0.1.0",
      "CFBundleVersion": "7",
    ])
    XCTAssertEqual(info, AppInfo(version: "0.1.0", build: "7"))
    XCTAssertEqual(info.versionDescription, "Version 0.1.0 (7)")
  }

  func testMissingOrBlankValuesReadAsUnknown() {
    XCTAssertEqual(
      AppInfo(infoDictionary: nil).versionDescription, "Version Unknown (Unknown)")
    let blank = AppInfo(infoDictionary: [
      "CFBundleShortVersionString": "  ",
      "CFBundleVersion": 7,
    ])
    XCTAssertEqual(blank, AppInfo(version: "Unknown", build: "Unknown"))
  }
}
