import Foundation

/// The version and build of the running app, read from its Info.plist.
public struct AppInfo: Equatable, Sendable {
  public let version: String
  public let build: String

  public init(version: String, build: String) {
    self.version = version
    self.build = build
  }

  /// Reads `CFBundleShortVersionString` and `CFBundleVersion`. A missing or blank value reads as
  /// "Unknown" rather than an empty string, so the About sheet never shows a bare "()".
  public init(infoDictionary: [String: Any]?) {
    self.init(
      version: Self.value(for: "CFBundleShortVersionString", in: infoDictionary),
      build: Self.value(for: "CFBundleVersion", in: infoDictionary)
    )
  }

  /// "Version 0.1.0 (1)".
  public var versionDescription: String {
    "Version \(version) (\(build))"
  }

  static let unknown = "Unknown"

  private static func value(for key: String, in info: [String: Any]?) -> String {
    guard let raw = info?[key] as? String else { return unknown }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? unknown : trimmed
  }
}
