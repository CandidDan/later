import Foundation

@MainActor
enum AuthServiceFactory {
  static func make() throws -> AuthService {
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.arguments.contains("--uitesting-auth") {
        return AuthTestSupport.makeService()
      }
    #endif
    let info = Bundle.main.infoDictionary ?? [:]
    let config = try AppAuthConfiguration(info: info)
    var unsignedSimulator = false
    #if DEBUG && targetEnvironment(simulator)
      unsignedSimulator = info["LATER_CODE_SIGNING_ALLOWED"] as? String == "NO"
    #endif
    let storage = try KeychainSessionStorage(
      accessGroup: info["LATER_KEYCHAIN_ACCESS_GROUP"] as? String,
      allowUnsignedDebugSimulator: unsignedSimulator)
    let group = unsignedSimulator ? nil : info["LATER_APP_GROUP"] as? String
    let caches = try UserCacheCleaner.live(appGroupIdentifier: group)
    return AuthService(
      backend: SupabaseAuthBackend(configuration: config, storage: storage),
      storage: storage, caches: caches)
  }
}
