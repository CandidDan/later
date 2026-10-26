import Foundation
import LaterKit

/// The running app's version and build, from its Info.plist.
enum BundleAppInfo {
  static var current: AppInfo { AppInfo(infoDictionary: Bundle.main.infoDictionary) }
}
