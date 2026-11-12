import XCTest

@testable import Later

final class AuthConfigurationTests: XCTestCase {
  func testOnlyConfiguredHTTPSURLsAndPublicKeysAreAccepted() throws {
    let valid = [
      "SUPABASE_URL": "https://example.supabase.co", "LATER_API_BASE_URL": "https://notfor.now",
      "SUPABASE_ANON_KEY": "sb_publishable_test_fixture",
    ]
    let config = try AppAuthConfiguration(info: valid)
    XCTAssertEqual(config.supabaseURL.host, "example.supabase.co")
    XCTAssertEqual(config.apiBaseURL.host, "notfor.now")
    for (name, value) in [
      ("SUPABASE_URL", "https://YOUR_PROJECT.supabase.co"),
      ("SUPABASE_URL", "http://example.supabase.co"),
      ("LATER_API_BASE_URL", "https://name:password@notfor.now"),
      ("SUPABASE_ANON_KEY", "YOUR_SUPABASE_PUBLIC_ANON_KEY"),
      ("SUPABASE_ANON_KEY", "sb_secret_forbidden"),
      ("SUPABASE_ANON_KEY", "x.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x"),
    ] {
      var changed = valid
      changed[name] = value
      XCTAssertThrowsError(try AppAuthConfiguration(info: changed), name)
    }
    XCTAssertTrue(AppAuthConfiguration.isPublicKey("x.eyJyb2xlIjoiYW5vbiJ9.x"))
    XCTAssertFalse(AppAuthConfiguration.isPublicKey("x.!!!.x"))
  }
}
