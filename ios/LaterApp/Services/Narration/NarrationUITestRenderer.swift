#if DEBUG && targetEnvironment(simulator)
  import AVFoundation
  import Foundation
  import LaterKit

  /// Deterministic audio for simulator UI tests only. Production always uses the iPhone voice.
  @MainActor
  final class NarrationUITestRenderer: NarrationRendering {
    private var attempted = false
    func render(_ text: NarrationText, in directory: URL) throws -> RenderedNarration {
      if !attempted && ProcessInfo.processInfo.arguments.contains("--narration-retry") {
        attempted = true
        throw CocoaError(.fileWriteOutOfSpace)
      }
      guard let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
        let buffer = AVAudioPCMBuffer(
          pcmFormat: format,
          frameCapacity: ProcessInfo.processInfo.arguments.contains("--uitesting-player")
            ? 2_880_000 : 48_000)
      else { throw DeviceNarrationRenderer.RenderError.invalidBuffer }
      buffer.frameLength = buffer.frameCapacity
      if let samples = buffer.floatChannelData {
        samples[0].initialize(repeating: 0, count: Int(buffer.frameLength))
      }
      let url = directory.appendingPathComponent("audio.caf")
      try AVAudioFile(forWriting: url, settings: format.settings).write(from: buffer)
      return RenderedNarration(file: url, voiceID: "simulator.ui.fixture")
    }
    func cancel() {}
  }
#endif
