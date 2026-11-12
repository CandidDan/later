import { describe, expect, it } from "vitest";
import { assembleNarration } from "./narration";
import { captureId, fullExtraction } from "./test-fixture";
describe("narration attribution", () => {
  it("uses the source host when site/byline/title are unavailable", () => {
    const original = fullExtraction();
    const extraction = { ...original, byline: null, site_name: null, title: null };
    expect(assembleNarration(captureId, extraction, "https://example.com/story")).toMatchObject({ title: "example.com", byline: null, siteName: null, intro: "example.com. From example.com. Narrated by Later.", outro: "End of example.com, from example.com.", paragraphs: original.paragraphs });
  });
  it("refuses social sources and unavailable safe destinations", () => {
    expect(assembleNarration(captureId, fullExtraction(), "https://youtube.com/watch?v=abcdefghi")).toEqual({ status: "open_original", reason: "not_an_article" });
    expect(assembleNarration(captureId, fullExtraction())).toEqual({ status: "open_original", reason: "no_source" });
  });
  it("fails closed rather than rewriting or omitting malformed stored paragraphs", () => {
    for (const paragraphs of [[], [null], [""], "not an array"]) expect(() => assembleNarration(captureId, { ...fullExtraction(), paragraphs }, "https://example.com/story")).toThrow("Invalid narration");
  });
});
