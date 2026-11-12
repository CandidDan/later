import { describe, expect, it } from "vitest";
import { projectCard, type Row } from "../revisit/card";
import { projectLibraryItem } from "./library";
import { captureId, fullExtraction, publicHost } from "./test-fixture";
const capture = { id: captureId, raw_text: "https://example.com/article", capture_kind: "url", source_platform: "web", captured_at: "2026-11-12T00:00:00Z" };
const run: Row = { id: "run-1", analysis_type: "source_resolution", status: "succeeded", created_at: "2026-11-12T00:00:00Z", input_snapshot: { evidence: [{ id: "url", kind: "captured_url", value: "https://example.com/article" }, { id: "title", kind: "metadata_title", value: "Source title" }, { id: "creator", kind: "metadata_creator", value: "Source creator" }], publicMetadata: [{ title: "Source title", creator: "Source creator", contentType: "article" }] }, result: { status: "resolved", sourceType: "article", title: "Source title", creator: "Source creator", canonicalUrl: "https://example.com/article", durationSeconds: null, transcriptUrl: null, confidence: 1, evidence: ["url", "title", "creator"] } };
describe("library mapping", () => {
  it("reuses the card projection's title, creator, source and safe destinations", async () => {
    const card = await projectCard(capture, [run], [], publicHost);
    const item = await projectLibraryItem(capture, [run], fullExtraction(), [], publicHost);
    expect(item).toEqual({ captureId, title: card.title, creator: card.creator, source: card.source, sourceUrl: card.sourceDestination ?? card.originalDestination, savedAt: card.savedAt, kind: "article", listen: { state: "narratable", wordCount: 250, textVersion: "a".repeat(64) } });
  });
  it.each(["pending", "processing"])("AC6 extraction %s maps to preparing", async status => {
    const item = await projectLibraryItem(capture, [run], undefined, [{ job_type: "article_extraction", status }], publicHost);
    expect(item.listen).toEqual({ state: "preparing" });
  });
  it("AC6 unfinished source resolution is preparing; terminal failure without an extraction is no_source", async () => {
    expect((await projectLibraryItem(capture, [], undefined, [], publicHost)).listen).toEqual({ state: "preparing" });
    expect((await projectLibraryItem(capture, [], undefined, [{ job_type: "source_resolution", status: "failed" }], publicHost)).listen).toEqual({ state: "open_original", reason: "no_source" });
  });
  it.each(["not_an_article", "paywalled", "truncated", "too_short", "not_html", "extraction_failed", "fetch_failed"])("AC6 preserves exact open_original reason %s", async reason => {
    expect((await projectLibraryItem(capture, [run], { status: "unsupported", reason }, [], publicHost)).listen).toEqual({ state: "open_original", reason });
  });
  it.each([["https://www.youtube.com/watch?v=abcdefghi", "video"], ["https://youtu.be/abcdefghi", "video"], ["https://www.tiktok.com/@author/video/123", "video"], ["https://open.spotify.com/episode/0123456789", "audio"], ["https://www.instagram.com/p/post", "post"], ["https://x.com/author/status/123", "post"], ["https://twitter.com/author/status/123", "post"]])("%s always opens original as %s, even if a full extraction is mislabelled", async (url, kind) => {
    const item = await projectLibraryItem({ ...capture, raw_text: url }, [], fullExtraction(), [], publicHost);
    expect(item.kind).toBe(kind); expect(item.listen).toEqual({ state: "open_original", reason: "not_an_article" });
  });
  it("does not treat a lookalike host as a platform", async () => {
    expect((await projectLibraryItem({ ...capture, raw_text: "https://youtube.com.evil.example/story" }, [run], fullExtraction(), [], publicHost)).kind).toBe("article");
  });
  it("handles un-enriched text and validates unsafe source destinations using the card policy", async () => {
    const item = await projectLibraryItem({ ...capture, raw_text: "https://127.0.0.1/private", source_platform: "", capture_kind: "text" }, [], undefined, [{ job_type: "source_resolution", status: "failed" }], publicHost);
    expect(item).toMatchObject({ title: null, creator: null, source: null, sourceUrl: null, kind: "text", listen: { state: "open_original", reason: "no_source" } });
  });
});
