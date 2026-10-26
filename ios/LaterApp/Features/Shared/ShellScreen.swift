import SwiftUI

/// A tab's navigation chrome: its title, the themed background, and the About button.
struct ShellScreen<Content: View>: View {
  let title: String
  let content: Content
  @State private var showingAbout = false

  init(title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    NavigationStack {
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ColorToken.background.color)
        .navigationTitle(title)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("About", systemImage: "info.circle") { showingAbout = true }
              .accessibilityIdentifier("about.open")
          }
        }
        .sheet(isPresented: $showingAbout) {
          AboutView()
        }
    }
  }
}
