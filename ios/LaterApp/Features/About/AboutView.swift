import LaterKit
import SwiftUI

struct AboutView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AuthService.self) private var auth

  var body: some View {
    NavigationStack {
      VStack(spacing: 8) {
        Text("Later")
          .font(.title.bold())
          .foregroundStyle(ColorToken.textPrimary.color)
        Text(BundleAppInfo.current.versionDescription)
          .font(.body)
          .foregroundStyle(ColorToken.textSecondary.color)
          .accessibilityIdentifier("about.version")
        if let email = auth.session?.user.email {
          Text(email)
            .font(.body)
            .foregroundStyle(ColorToken.textSecondary.color)
            .accessibilityIdentifier("about.email")
        }
        Button("Sign out", role: .destructive) {
          Task {
            dismiss()
            await auth.signOut()
          }
        }
        .disabled(auth.isBusy)
        .accessibilityIdentifier("about.signOut")
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(ColorToken.surface.color)
      .navigationTitle("About")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("about.done")
        }
      }
    }
  }
}
