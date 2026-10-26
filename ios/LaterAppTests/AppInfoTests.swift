import XCTest

@testable import Later

final class BundleAppInfoTests: XCTestCase {
  func testReadsTheHostAppsVersionAndBuild() {
    let info = Bundle.main.infoDictionary
    XCTAssertEqual(BundleAppInfo.current.version, info?["CFBundleShortVersionString"] as? String)
    XCTAssertEqual(BundleAppInfo.current.build, info?["CFBundleVersion"] as? String)
    XCTAssertNotEqual(BundleAppInfo.current.version, "Unknown")
  }
}
