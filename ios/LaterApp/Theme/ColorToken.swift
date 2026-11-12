import SwiftUI
import UIKit

/// Later's semantic colours. This file is the only place a colour value appears in the app:
/// views ask for a token (`ColorToken.textPrimary.color`), never for a colour, so swapping the
/// palette is a change to this file alone.
///
/// The palette is NOT approved yet. These are provisional values taken from iOS system semantic
/// colours, so light and dark appearance resolve automatically. `ThemeTests` holds every
/// text/background pair to WCAG 4.5:1 in both appearances, whatever values replace these.
enum ColorToken: String, CaseIterable, Sendable {
  case background
  case surface
  case surfaceRaised
  case textPrimary
  case textSecondary
  case accent
  case onAccent
  case divider
  case destructive

  var uiColor: UIColor {
    switch self {
    case .background: .systemBackground
    case .surface: .secondarySystemBackground
    case .surfaceRaised: .tertiarySystemBackground
    case .textPrimary: .label
    // `.secondaryLabel` is 60% opaque and falls below 4.5:1 on the light surfaces, so secondary
    // text is the primary label at a higher opacity.
    case .textSecondary:
      UIColor { traits in UIColor.label.resolvedColor(with: traits).withAlphaComponent(0.72) }
    // Indigo becomes lighter in dark appearance, so its foreground switches to black.
    case .accent: .systemIndigo
    case .onAccent:
      UIColor { traits in traits.userInterfaceStyle == .dark ? .black : .white }
    case .divider: .separator
    case .destructive: .systemRed
    }
  }

  var color: Color { Color(uiColor: uiColor) }
}
