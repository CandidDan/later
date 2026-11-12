import Foundation

public struct NarrationText: Codable, Sendable {
  public let captureId: UUID
  public let textVersion: String
  public let title: String
  public let byline: String?
  public let siteName: String?
  public let sourceUrl: String
  public let intro: String
  public let paragraphs: [String]
  public let outro: String
  public let wordCount: Int
}

public struct NarrationUtterance: Equatable, Sendable {
  public let text: String
  public let pauseAfter: Double
}

public enum NarrationScript {
  public static func utterances(for text: NarrationText) -> [NarrationUtterance] {
    ([text.intro] + text.paragraphs + [text.outro]).flatMap { paragraph in
      let chunks = chunks(paragraph)
      return chunks.enumerated().map { index, chunk in
        NarrationUtterance(text: chunk, pauseAfter: index == chunks.count - 1 ? 0.3 : 0)
      }
    }
  }

  /// Retain every character, including whitespace. A sentence longer than the target stays whole.
  /// Conservative boundaries avoid splitting decimals, initials and common abbreviations.
  public static func chunks(_ paragraph: String, target: Int = 1_200) -> [String] {
    guard paragraph.count > max(1, target) else { return [paragraph] }
    let abbreviations: Set<String> = [
      "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
    ]
    let characters = Array(paragraph)
    var boundaries: [Int] = []
    for index in characters.indices where ".!?。！？".contains(characters[index]) {
      var end = index + 1
      while end < characters.count && "\"'”’)]".contains(characters[end]) { end += 1 }
      let beforeSpace = end
      while end < characters.count && characters[end].isWhitespace { end += 1 }
      guard end > beforeSpace || end == characters.count || "。！？".contains(characters[index]) else {
        continue
      }
      if characters[index] == "." {
        let prefix = String(characters[..<index])
        let word = prefix.split(whereSeparator: { !$0.isLetter }).last.map(String.init) ?? ""
        if word.count == 1 || abbreviations.contains(word.lowercased()) { continue }
        if end < characters.count && characters[end].isLowercase { continue }
      }
      boundaries.append(end)
    }
    var start = 0
    var result: [String] = []
    for end in boundaries where end > start && end - start >= max(1, target) {
      result.append(String(characters[start..<end]))
      start = end
    }
    if start < characters.count { result.append(String(characters[start...])) }
    return result.isEmpty ? [paragraph] : result
  }
}
