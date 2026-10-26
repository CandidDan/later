import Foundation
import UIKit
import XCTest

@testable import Later

final class ThemeTests: XCTestCase {
  // MARK: - Contrast

  private static let textPairs: [(text: ColorToken, on: ColorToken)] =
    [ColorToken.textPrimary, .textSecondary].flatMap { text in
      [ColorToken.background, .surface, .surfaceRaised].map { (text, $0) }
    } + [(.onAccent, .accent)]

  func testTokenContrast() {
    XCTAssertEqual(Self.textPairs.count, 7)
    for style in [UIUserInterfaceStyle.light, .dark] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      for (text, background) in Self.textPairs {
        let bg = RGBA(background.uiColor.resolvedColor(with: traits))
        XCTAssertEqual(
          bg.alpha, 1, accuracy: 0.001, "\(background) must be opaque in \(style.name)")
        let fg = RGBA(text.uiColor.resolvedColor(with: traits)).composited(over: bg)
        let ratio = fg.contrastRatio(with: bg)
        XCTAssertGreaterThanOrEqual(
          ratio, 4.5,
          "\(text) on \(background) in \(style.name) is \(String(format: "%.2f", ratio)):1")
      }
    }
  }

  func testEveryTokenResolvesInBothAppearances() {
    for token in ColorToken.allCases {
      for style in [UIUserInterfaceStyle.light, .dark] {
        let resolved = RGBA(token.uiColor.resolvedColor(with: .init(userInterfaceStyle: style)))
        XCTAssertGreaterThan(resolved.alpha, 0, "\(token) is invisible in \(style.name)")
      }
    }
  }

  // MARK: - Colour values and fonts live in the Theme file only

  /// `ios/LaterApp/`, found from this file's own path. Simulator tests run on the host Mac, so
  /// the source tree is readable.
  private static let appSources = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("LaterApp", isDirectory: true)

  private static let themeFile = "Theme/ColorToken.swift"

  private static let namedColours = [
    "red", "orange", "yellow", "green", "mint", "teal", "cyan", "blue", "indigo", "purple", "pink",
    "brown", "white", "gray", "black", "clear", "primary", "secondary", "tertiary", "quaternary",
    "accentColor",
  ]

  private static let colourPatterns = [
    #"\bColor\s*\("#,  // Color(red:…), Color(hue:…), Color("Asset"), Color(uiColor:…)
    #"\bColor\.\w+"#,  // Color.red, Color.accentColor
    #"\b(UI|NS|CG)Color\b"#,
    #"#colorLiteral"#,
    // `.foregroundStyle(.red)`, `tint: .secondary`: a named colour in argument position.
    #"[(:,]\s*\.("# + namedColours.joined(separator: "|") + #")\b"#,
  ]

  private static let fontPatterns = [
    #"\.serif\b"#,
    #"\bFont\.custom\b"#,
    #"\.custom\s*\("#,
    #"\bUIFont\s*\(\s*name:"#,
  ]

  static func matches(_ patterns: [String], in source: String) -> [String] {
    patterns.filter { source.range(of: $0, options: .regularExpression) != nil }
  }

  func testNoColourLiteralsOrSerifOutsideTheme() throws {
    let root = Self.appSources.standardizedFileURL
    let files = try XCTUnwrap(
      FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
    ).compactMap { $0 as? URL }
    let relative = files.map { String($0.standardizedFileURL.path.dropFirst(root.path.count + 1)) }

    let swift = relative.filter { $0.hasSuffix(".swift") }
    XCTAssertTrue(swift.contains(Self.themeFile), "no Theme token file under \(root.path)")
    XCTAssertGreaterThanOrEqual(swift.count, 5, "found too few sources to trust the scan")

    for path in swift {
      let source = try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
      XCTAssertEqual(
        Self.matches(Self.fontPatterns, in: source), [], "\(path) uses a serif or custom font")
      if path != Self.themeFile {
        XCTAssertEqual(
          Self.matches(Self.colourPatterns, in: source), [], "\(path) has a colour value")
      }
    }
    let assets = relative.filter { path in
      [".colorset", ".ttf", ".otf"].contains { path.hasSuffix($0) }
    }
    XCTAssertEqual(assets, [], "colour sets and font files put colour or font values outside Theme")
  }

  /// The scan above passes vacuously if its patterns cannot match; prove they do.
  func testScanPatternsCatchKnownViolations() {
    for bad in [
      "Text(\"x\").foregroundStyle(.red)", "Color(red: 1, green: 0, blue: 0)", "Color.accentColor",
      "UIColor.systemYellow", "Color(\"Brand\")", ".tint(.secondary)",
    ] {
      XCTAssertFalse(Self.matches(Self.colourPatterns, in: bad).isEmpty, bad)
    }
    for bad in [".font(.system(.body, design: .serif))", ".font(.custom(\"Georgia\", size: 17))"] {
      XCTAssertFalse(Self.matches(Self.fontPatterns, in: bad).isEmpty, bad)
    }
    let tokenUse = ".foregroundStyle(ColorToken.textPrimary.color)"
    XCTAssertEqual(Self.matches(Self.colourPatterns, in: tokenUse), [])
  }
}

/// A resolved colour's sRGB components, and the WCAG 2 contrast arithmetic.
private struct RGBA {
  var red, green, blue, alpha: Double

  init(red: Double, green: Double, blue: Double, alpha: Double) {
    (self.red, self.green, self.blue, self.alpha) = (red, green, blue, alpha)
  }

  init(_ color: UIColor) {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    let clamp = { (v: CGFloat) in min(1, max(0, Double(v))) }
    self.init(red: clamp(r), green: clamp(g), blue: clamp(b), alpha: clamp(a))
  }

  func composited(over background: RGBA) -> RGBA {
    let mix = { (fg: Double, bg: Double) in fg * alpha + bg * (1 - alpha) }
    return RGBA(
      red: mix(red, background.red), green: mix(green, background.green),
      blue: mix(blue, background.blue), alpha: 1)
  }

  var luminance: Double {
    let linear = { (c: Double) in c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  }

  func contrastRatio(with other: RGBA) -> Double {
    let (l1, l2) = (luminance, other.luminance)
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
  }
}

extension UIUserInterfaceStyle {
  fileprivate var name: String { self == .dark ? "dark" : "light" }
}
