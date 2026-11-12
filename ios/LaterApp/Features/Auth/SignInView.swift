import SwiftUI

struct SignInView: View {
  @Environment(AuthService.self) private var auth
  @State private var email = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        Image(systemName: "bookmark")
          .font(.largeTitle)
          .foregroundStyle(ColorToken.accent.color)
          .accessibilityHidden(true)
        Text("Welcome to Later")
          .font(.largeTitle.bold())
        Text("Sign in to keep your saves with you.")
          .font(.body)
          .foregroundStyle(ColorToken.textSecondary.color)
        TextField("Email address", text: $email)
          .textContentType(.emailAddress)
          .keyboardType(.emailAddress)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .textFieldStyle(.roundedBorder)
          .accessibilityLabel("Email address")
          .accessibilityIdentifier("auth.email")
          .disabled(auth.isBusy || auth.cleanupRequired)
          .onSubmit { submit() }
        Button(auth.checkEmail ? "Send another link" : "Email me a sign-in link") { submit() }
          .buttonStyle(.borderedProminent)
          .tint(ColorToken.accent.color)
          .foregroundStyle(ColorToken.onAccent.color)
          .disabled(
            email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || auth.isBusy
              || auth.cleanupRequired
          )
          .accessibilityIdentifier("auth.submit")
        if auth.isBusy { ProgressView().accessibilityLabel("Signing in") }
        if auth.checkEmail {
          VStack(alignment: .leading, spacing: 8) {
            Text("Check your email").font(.headline)
            Text(
              "If this email belongs to your Later account, a sign-in link is on its way. "
                + "Open the latest link on this iPhone.")
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("auth.checkEmail")
        }
        if let message = auth.errorMessage {
          Text(message)
            .foregroundStyle(ColorToken.textSecondary.color)
            .accessibilityIdentifier("auth.error")
        }
        if auth.cleanupRequired {
          Button("Retry sign out") { Task { await auth.signOut() } }
        }
        Text("Later is for existing accounts. No new account will be created.")
          .font(.footnote)
          .foregroundStyle(ColorToken.textSecondary.color)
      }
      .padding(32)
      .frame(maxWidth: 520, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .foregroundStyle(ColorToken.textPrimary.color)
    .background(ColorToken.background.color)
    .accessibilityIdentifier("auth.signIn")
  }

  private func submit() {
    Task { await auth.requestMagicLink(email: email) }
  }
}
