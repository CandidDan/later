import LaterKit
import SwiftUI

struct ListenView: View {
  @Environment(NarrationCoordinator.self) private var coordinator
  @State private var model: ListenViewModel?
  private var revision: String {
    let items = coordinator.model?.items ?? []
    return items.map { item in
      let manifest = coordinator.model?.narration?.manifest(for: item)
      return "\(item.id):\(item.listen.textVersion ?? ""):\(manifest?.directory.uuidString ?? "")"
    }.joined(separator: ",") + ":\(coordinator.model?.narration?.snapshot.pending.count ?? 0)"
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          if let model {
            if let item = model.continuing {
              Button {
                if model.playItem(item.id) { coordinator.showingPlayer = true }
              } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text("Continue").font(.headline)
                  row(item)
                }.frame(maxWidth: .infinity, alignment: .leading)
              }.accessibilityIdentifier("listen.continue")
            }
            Text(model.plan?.summary ?? "Nothing's ready to listen to yet")
              .font(.headline).accessibilityIdentifier("listen.summary")
            ForEach(model.planned) { row($0) }
            if model.snapshot.preparing > 0 {
              Text("\(model.snapshot.preparing) more are being prepared")
                .accessibilityIdentifier("listen.preparing")
            }
            if !model.longer.isEmpty {
              Text("Longer listens").font(.headline)
              ForEach(model.longer) { item in
                Button {
                  if model.playItem(item.id) { coordinator.showingPlayer = true }
                } label: {
                  row(item)
                }
              }
            }
            if let message = model.message {
              Text(message).accessibilityIdentifier("listen.message")
            }
            if let message = coordinator.model?.message { Text(message) }
            Button("Refresh") { model.refresh() }
          } else {
            ProgressView("Loading listens")
          }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
      }
      .safeAreaInset(edge: .bottom) {
        if let model {
          VStack(spacing: 12) {
            HStack {
              ForEach(ListenSlot.allCases, id: \.rawValue) { slot in
                Button {
                  model.select(slot)
                } label: {
                  Text("\(slot.rawValue / 60) min")
                    .fontWeight(model.slot == slot ? .bold : .regular)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .foregroundStyle(ColorToken.onAccent.color)
                .background(ColorToken.accent.color, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityAddTraits(model.slot == slot ? .isSelected : [])
                .accessibilityIdentifier("listen.slot.\(slot.rawValue / 60)")
              }
            }
            Button {
              if model.playPlan() { coordinator.showingPlayer = true }
            } label: {
              Label("Play", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 44)
            }
            .disabled(model.planned.isEmpty)
            .accessibilityIdentifier("listen.play")
          }.padding().background(ColorToken.surface.color)
        }
      }
      .foregroundStyle(ColorToken.textPrimary.color)
      .background(ColorToken.background.color)
      .navigationTitle("Listen")
      .task(id: revision) {
        if model == nil { model = ListenViewModel.live(coordinator) }
        model?.refresh()
      }
    }
  }
  private func row(_ item: ReadyListen) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(item.item.displayTitle).font(.headline)
      Text(
        "\(item.item.displaySource) · \(ListeningDuration.format(.seconds(Int64(ceil(item.duration - item.position))))) remaining"
      )
      .font(.subheadline)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
  }
}
