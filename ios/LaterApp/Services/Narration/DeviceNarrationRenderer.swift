import AVFoundation
import Foundation
import LaterKit

@MainActor
final class DeviceNarrationRenderer: NarrationRendering {
  enum RenderError: Error { case noVoice, emptyAudio, invalidBuffer }
  private let synthesizer = AVSpeechSynthesizer()
  private var sink: SpeechFileSink?
  private var exportSession: AVAssetExportSession?

  static func voice(
    language: String = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
  )
    -> AVSpeechSynthesisVoice?
  {
    let installed = AVSpeechSynthesisVoice.speechVoices()
    let prefix = language.split(separator: "-").first.map(String.init) ?? language
    let matching = installed.filter {
      $0.language.split(separator: "-").first.map(String.init) == prefix
    }
    let preferred = matching.filter { $0.quality == .premium || $0.quality == .enhanced }.sorted {
      if $0.quality.rawValue != $1.quality.rawValue {
        return $0.quality.rawValue > $1.quality.rawValue
      }
      return ($0.language == language ? 0 : 1) < ($1.language == language ? 0 : 1)
    }
    return preferred.first ?? AVSpeechSynthesisVoice(language: language) ?? matching.first
  }

  func render(_ text: NarrationText, in directory: URL) async throws -> RenderedNarration {
    guard let voice = Self.voice() else { throw RenderError.noVoice }
    let caf = directory.appendingPathComponent("audio.caf")
    let sink = SpeechFileSink(url: caf)
    self.sink = sink
    defer { synthesizer.stopSpeaking(at: .immediate); self.sink = nil; sink.close() }
    try await withTaskCancellationHandler {
      for part in NarrationScript.utterances(for: text) where !part.text.isEmpty {
        try Task.checkCancellation()
        let utterance = AVSpeechUtterance(string: part.text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        try await withCheckedThrowingContinuation {
          (continuation: CheckedContinuation<Void, Error>) in
          sink.begin(continuation, pause: part.pauseAfter)
          synthesizer.write(utterance) { buffer in sink.receive(buffer) }
        }
      }
    } onCancel: {
      sink.cancel()
      Task { @MainActor [weak self] in self?.synthesizer.stopSpeaking(at: .immediate) }
    }
    sink.close()
    guard sink.framesWritten > 0 else { throw RenderError.emptyAudio }
    try Task.checkCancellation()
    let m4a = directory.appendingPathComponent("audio.m4a")
    if let export = AVAssetExportSession(
      asset: AVURLAsset(url: caf), presetName: AVAssetExportPresetAppleM4A)
    {
      exportSession = export
      defer { exportSession = nil }
      do {
        try await export.export(to: m4a, as: .m4a)
        try Task.checkCancellation()
        try FileManager.default.removeItem(at: caf)
        return RenderedNarration(file: m4a, voiceID: voice.identifier)
      } catch {
        try? FileManager.default.removeItem(at: m4a)
        try Task.checkCancellation()
        // CAF remains a valid, complete local file when AAC export isn't available.
      }
    }
    return RenderedNarration(file: caf, voiceID: voice.identifier)
  }

  func cancel() {
    exportSession?.cancelExport()
    sink?.cancel()
    synthesizer.stopSpeaking(at: .immediate)
  }
}

/// AVSpeechSynthesizer delivers buffers off the main actor. All mutable file/continuation state
/// is under this lock. Buffers are written before returning to AVFoundation; none escape it.
private final class SpeechFileSink: @unchecked Sendable {
  private let lock = NSLock()
  private let url: URL
  private var file: AVAudioFile?
  private var continuation: CheckedContinuation<Void, Error>?
  private var cancelled = false
  private var pause: Double = 0
  private var frames: Int64 = 0

  init(url: URL) { self.url = url }
  var framesWritten: Int64 { lock.withLock { frames } }

  func begin(_ continuation: CheckedContinuation<Void, Error>, pause: Double) {
    lock.withLock {
      if cancelled { continuation.resume(throwing: CancellationError()); return }
      self.pause = pause
      self.continuation = continuation
    }
  }

  func receive(_ buffer: AVAudioBuffer) {
    lock.withLock {
      guard !cancelled, continuation != nil else { return }
      do {
        guard let pcm = buffer as? AVAudioPCMBuffer else {
          throw DeviceNarrationRenderer.RenderError.invalidBuffer
        }
        if pcm.frameLength == 0 {
          if let file, pause > 0,
            let silence = AVAudioPCMBuffer(
              pcmFormat: file.processingFormat,
              frameCapacity: AVAudioFrameCount(file.processingFormat.sampleRate * pause))
          {
            silence.frameLength = silence.frameCapacity
            for entry in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
              if let data = entry.mData { memset(data, 0, Int(entry.mDataByteSize)) }
            }
            try file.write(from: silence)
            frames += Int64(silence.frameLength)
          }
          continuation?.resume()
          continuation = nil
          return
        }
        if file == nil {
          // The protected parent already exists. Never recreate it from a late callback after sign-out.
          file = try AVAudioFile(
            forWriting: url, settings: pcm.format.settings,
            commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
          try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path)
        }
        try file?.write(from: pcm)
        frames += Int64(pcm.frameLength)
      } catch {
        continuation?.resume(throwing: error)
        continuation = nil
        cancelled = true
      }
    }
  }

  func close() { lock.withLock { file = nil } }
  func cancel() {
    lock.withLock {
      cancelled = true
      continuation?.resume(throwing: CancellationError())
      continuation = nil
      file = nil
    }
  }
}
