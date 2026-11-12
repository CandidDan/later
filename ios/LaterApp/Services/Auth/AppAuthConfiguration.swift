import Foundation

struct AppAuthConfiguration {
  let supabaseURL: URL
  let anonymousKey: String
  let apiBaseURL: URL

  enum ConfigurationError: Error {
    case invalid
  }

  init(info: [String: Any]) throws {
    guard let url = Self.httpsURL(info["SUPABASE_URL"]),
      let apiURL = Self.httpsURL(info["LATER_API_BASE_URL"]),
      let key = info["SUPABASE_ANON_KEY"] as? String,
      Self.isPublicKey(key)
    else { throw ConfigurationError.invalid }
    supabaseURL = url
    anonymousKey = key
    apiBaseURL = apiURL
  }

  private static func httpsURL(_ value: Any?) -> URL? {
    guard let raw = value as? String,
      !raw.lowercased().contains("your_"),
      let url = URL(string: raw), url.scheme == "https", let host = url.host, !host.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
    else { return nil }
    return url
  }

  static func isPublicKey(_ key: String) -> Bool {
    if key.hasPrefix("sb_publishable_"), key.count > 20 { return true }
    let parts = key.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return false }
    var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
    guard let data = Data(base64Encoded: payload),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    return json["role"] as? String == "anon"
  }
}
