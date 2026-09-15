import { describe, expect, it } from "vitest";

import { parseSourceResolutionResult, SourceResolutionResultSchemaError, type SourceEvidence } from "./result";

const evidence: SourceEvidence[] = [
  { id: "metadata.0.title", kind: "metadata_title", value: "Known Episode" },
  { id: "metadata.0.creator", kind: "metadata_creator", value: "Known Creator" },
  { id: "metadata.0.canonicalUrl", kind: "metadata_canonical_url", value: "https://example.com/known" },
  { id: "resolution.notice.0", kind: "resolution_notice", value: "insufficient_evidence" },
];

describe("source result schema", () => {
  it("AC2 accepts a resolved identity only when every identity value cites snapshot evidence", () => {
    expect(parseSourceResolutionResult({
      status: "resolved",
      sourceType: "podcast_episode",
      title: "Known Episode",
      creator: "Known Creator",
      canonicalUrl: "https://example.com/known",
      durationSeconds: null,
      transcriptUrl: null,
      confidence: 0.8,
      evidence: ["metadata.0.title", "metadata.0.creator", "metadata.0.canonicalUrl"],
    }, evidence)).toMatchObject({ status: "resolved", canonicalUrl: "https://example.com/known" });
  });

  it.each([
    ["an unknown evidence id", { evidence: ["capture.private-field"] }],
    ["an invented title", { title: "Invented Episode" }],
    ["an invented canonical URL", { canonicalUrl: "https://invented.example/source" }],
  ])("AC2 rejects %s", (_label, override) => {
    expect(() => parseSourceResolutionResult({
      status: "resolved",
      sourceType: "podcast_episode",
      title: "Known Episode",
      creator: "Known Creator",
      canonicalUrl: "https://example.com/known",
      durationSeconds: null,
      transcriptUrl: null,
      confidence: 0.8,
      evidence: ["metadata.0.title", "metadata.0.creator", "metadata.0.canonicalUrl"],
      ...override,
    }, evidence)).toThrow(SourceResolutionResultSchemaError);
  });

  it("AC3 requires every identity field to be null for unresolved outcomes", () => {
    expect(() => parseSourceResolutionResult({
      status: "unresolved",
      sourceType: null,
      title: "A guess",
      creator: null,
      canonicalUrl: null,
      durationSeconds: null,
      transcriptUrl: null,
      confidence: 0.1,
      evidence: ["resolution.notice.0"],
    }, evidence)).toThrow(/unresolved title must be null/u);
  });
});
