import SwiftUI

/// An honest empty state until the signed-in app connects its data screens.
struct NotConnectedView: View {
  let identifier: String
  let message: String
  let detail: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "tray")
        .font(.largeTitle)
        .foregroundStyle(ColorToken.textSecondary.color)
        .accessibilityHidden(true)
      Text(message)
        .font(.headline)
        .foregroundStyle(ColorToken.textPrimary.color)
      Text(detail)
        .font(.subheadline)
        .foregroundStyle(ColorToken.textSecondary.color)
    }
    .multilineTextAlignment(.center)
    .padding(24)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier)
  }
}
