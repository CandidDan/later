import SwiftUI

/// Host completion is injected so dismissing the extension is owned by its controller.
struct ShareSheet: View {
  let input: ShareInput
  @Bindable var model: ShareViewModel
  let cancel: () -> Void
  let complete: () -> Void
  @State private var saveTask: Task<Void, Never>?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(input.preview)
            .font(.body)
            .foregroundStyle(ColorToken.textPrimary.color)
            .lineLimit(6)
            .accessibilityIdentifier("share-preview")
          TextField("Add a note (optional)", text: $model.note, axis: .vertical)
            .lineLimit(2...5)
            .disabled(model.isSaving || model.persistedRequest != nil)
            .accessibilityIdentifier("share-note")
        }
        .listRowBackground(ColorToken.surface.color)
        if let message = model.message ?? model.validationMessage {
          Section {
            Text(message)
              .foregroundStyle(ColorToken.textPrimary.color)
              .accessibilityIdentifier("share-status")
          }
          .listRowBackground(ColorToken.surface.color)
        }
        Section {
          if model.isFinished {
            Button("Done", action: complete)
              .accessibilityIdentifier("share-done")
          } else {
            Button {
              saveTask = Task { await model.save() }
            } label: {
              HStack {
                Text(model.isSaving ? "Saving…" : "Save")
                if model.isSaving { ProgressView() }
              }
            }
            .disabled(!model.canSave)
            .accessibilityIdentifier("share-save")
          }
        }
        .listRowBackground(ColorToken.surface.color)
      }
      .scrollContentBackground(.hidden)
      .background(ColorToken.background.color)
      .tint(ColorToken.accent.color)
      .navigationTitle("Save to Later")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            saveTask?.cancel()
            cancel()
          }
        }
      }
    }
    .onDisappear { saveTask?.cancel() }
  }
}
