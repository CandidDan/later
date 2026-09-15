import { describe, expect, it } from "vitest";

import type { SegmentMaterial } from "./segment-material";
import { parseSegmentResolutionResult, SegmentResolutionResultSchemaError } from "./segment-result";

const timed: SegmentMaterial = {
  requestedUrl: "https://example.com/transcript.vtt",
  finalUrl: "https://example.com/transcript.vtt",
  contentType: "text/vtt",
  sha256: "a".repeat(64),
  byteLength: 100,
  representation: "timed",
  durationSeconds: 120,
  content: "Opening Relevant captured interest Closing",
  evidence: [
    { id: "cue.0", kind: "timed", startSeconds: 10, endSeconds: 15, text: "Opening" },
    { id: "cue.1", kind: "timed", startSeconds: 15, endSeconds: 22, text: "Relevant captured interest" },
  ],
};

const text: SegmentMaterial = {
  requestedUrl: "https://example.com/article.txt",
  finalUrl: "https://example.com/article.txt",
  contentType: "text/plain",
  sha256: "b".repeat(64),
  byteLength: 50,
  representation: "text",
  durationSeconds: null,
  content: "Introduction\nRelevant captured interest\nConclusion",
  evidence: [{ id: "text.0", kind: "text", start: 0, end: 50,
    text: "Introduction\nRelevant captured interest\nConclusion" }],
};

function timedResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "resolved", representation: "timed", startSeconds: 15, endSeconds: 22,
    sectionStart: null, sectionEnd: null, excerpt: "Relevant captured interest", label: null,
    confidence: 0.91, evidence: ["cue.1"], ...overrides,
  };
}

describe("segment result validation", () => {
  it("AC1 accepts ordered in-range timestamps and an excerpt that exists in cited transcript evidence", () => {
    expect(parseSegmentResolutionResult(timedResult(), timed, timed.evidence)).toStrictEqual(timedResult());
  });

  it("AC2 accepts text boundaries containing a source excerpt without audio timestamps", () => {
    const start = text.content.indexOf("Relevant");
    const result = {
      status: "resolved", representation: "text", startSeconds: null, endSeconds: null,
      sectionStart: start, sectionEnd: start + "Relevant captured interest".length,
      excerpt: "Relevant captured interest", label: null, confidence: 0.8, evidence: ["text.0"],
    };
    expect(parseSegmentResolutionResult(result, text, text.evidence)).toStrictEqual(result);
  });

  it.each([
    ["negative timestamp", { startSeconds: -1 }],
    ["reversed timestamps", { startSeconds: 22, endSeconds: 15 }],
    ["out-of-duration timestamp", { endSeconds: 121 }],
    ["timestamp outside cited cues", { startSeconds: 14 }],
    ["excerpt absent from source", { excerpt: "Invented excerpt" }],
  ])("AC4 rejects a model result with %s", (_label, override) => {
    expect(() => parseSegmentResolutionResult(timedResult(override), timed, timed.evidence))
      .toThrow(SegmentResolutionResultSchemaError);
  });

  it("AC2 rejects fabricated audio timestamps for a text representation", () => {
    expect(() => parseSegmentResolutionResult({
      status: "resolved", representation: "text", startSeconds: 1, endSeconds: 2,
      sectionStart: null, sectionEnd: null, excerpt: "Relevant captured interest", label: null,
      confidence: 0.8, evidence: ["text.0"],
    }, text, text.evidence)).toThrow(/cannot fabricate timestamps/u);
  });

  it("AC3 requires every locator to be null on an unresolved result", () => {
    expect(() => parseSegmentResolutionResult({
      status: "unresolved", representation: null, startSeconds: 1, endSeconds: null,
      sectionStart: null, sectionEnd: null, excerpt: null, label: null,
      confidence: 0, evidence: ["segment.notice.0"],
    }, null, [{ id: "segment.notice.0", kind: "notice", value: "insufficient" }]))
      .toThrow(/unresolved startSeconds must be null/u);
  });
});
