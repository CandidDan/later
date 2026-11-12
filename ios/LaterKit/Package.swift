// swift-tools-version: 6.0
// LaterKit is Foundation-only: it must build and test on Linux (ios/scripts/linux-check.sh), so it
// never imports SwiftUI, UIKit, AVFoundation or Combine.
import PackageDescription

let package = Package(
  name: "LaterKit",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "LaterKit", targets: ["LaterKit"])
  ],
  targets: [
    .target(name: "LaterKit"),
    .testTarget(name: "LaterKitTests", dependencies: ["LaterKit"]),
  ],
  swiftLanguageModes: [.v6]
)
