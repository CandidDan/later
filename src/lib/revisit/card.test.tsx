import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectCard, safeDestination } from "./card";
import { formatSavedDate } from "./dates";
import { CaptureCardView, requestPrivateAsset } from "./capture-card";

const resolve = async () => [{ address: "8.8.8.8" }];
const capture = { id: "capture", raw_text: "Remember this https://youtu.be/abcdefgh", user_note: "For next week", capture_kind: "url", capture_channel: "whatsapp", captured_at: "2026-09-25T13:30:00Z" };
function run(id = "b", created_at = "2026-10-01T00:00:00Z", title = "Real source") {
  const evidence = [
    { id: "t", kind: "metadata_title", value: title }, { id: "c", kind: "metadata_creator", value: "A creator" },
    { id: "u", kind: "captured_url", value: "https://youtu.be/abcdefgh" }, { id: "d", kind: "metadata_duration", value: "90" },
  ];
  return { id, created_at, analysis_type: "source_resolution", status: "succeeded", input_snapshot: { publicMetadata: [{ title, creator: "A creator", durationSeconds: 90 }], evidence, intentAnalysis: { result: { summary: "Invented interest title" } } }, result: { status: "resolved", sourceType: "youtube_video", title, creator: "A creator", canonicalUrl: "https://youtu.be/abcdefgh", durationSeconds: 90, transcriptUrl: null, confidence: 1, evidence: ["t", "c", "u", "d"] } };
}
const render = (card: Awaited<ReturnType<typeof projectCard>>) => renderToStaticMarkup(<CaptureCardView card={card} accessToken="secret" now={new Date("2026-10-05T00:00:00Z")} timeZone="Australia/Sydney" />);

describe("capture card projection and presentation", () => {
  it("renders factual identity, source, kind, note and saved date; selects latest run with descending ID ties without merging", async () => {
    const older = run("z", "2026-09-30T00:00:00Z", "Old title");
    const losing = run("a", undefined, "Conflicting title");
    const card = await projectCard(capture, [older, losing, run()], [], resolve);
    const html = render(card);
    for (const value of ["Real source", "A creator", "youtu.be", "whatsapp", "url", "For next week", "26 Sept 2026", "9 days ago", "youtube_video (inferred)", "90 seconds"]) expect(html).toContain(value);
    expect(html).not.toMatch(/Old title|Conflicting title|Invented interest/);
    expect(html).toContain('rel="noopener noreferrer"');
    expect((await projectCard(capture, [run(), losing, older], [], resolve)).title).toBe(card.title);
  });
  it.each(["pending", "failed", "unresolved", "malformed"])("retains original context with %s enrichment and no fabricated fields", async state => {
    const r = run();
    if (state === "pending" || state === "failed") r.status = state;
    else { r.input_snapshot.publicMetadata = []; r.input_snapshot.evidence = []; r.result = { ...r.result, status: state }; }
    const card = await projectCard(capture, [r], [], resolve);
    expect(card.title).toBeUndefined(); expect(card.creator).toBeUndefined(); expect(card.durationSeconds).toBeUndefined();
    expect(render(card)).toContain("Remember this"); expect(card.originalDestination).toBe("https://youtu.be/abcdefgh");
  });
  it("uses factual metadata even when result is malformed, without treating hints as source metadata", async () => {
    const r = run(); r.result.evidence = ["missing"];
    const card = await projectCard(capture, [r], [], resolve);
    expect(card.title).toBe("Real source"); expect(card.sourceDestination).toBeUndefined();
  });
  it("escapes malicious text and HTML; removes unsafe navigation", async () => {
    const card = await projectCard({ ...capture, raw_text: '<script>alert(1)</script> javascript:alert(1) https://user:pass@evil.com https://127.0.0.1/x', user_note: '<img src=x onerror="alert(1)">' }, [], [], resolve);
    const html = render(card);
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).not.toContain("href=");
  });
  it.each(["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://localhost", "https://x.local", "https://10.0.0.1", "https://[::1]", "https://example.com:444", "data:text/html,hi"])("rejects unsafe destination %s", async url => { expect(await safeDestination(url, resolve)).toBeUndefined(); });
  it("rejects private/mixed DNS, lookup failure and malformed values", async () => {
    expect(await safeDestination("https://example.com", async () => [{ address: "10.0.0.1" }, { address: "8.8.8.8" }])).toBeUndefined();
    expect(await safeDestination("https://example.com", async () => { throw Error(); })).toBeUndefined();
    expect(await safeDestination({})).toBeUndefined();
  });
  it("shows raster fallback pending authenticated loading and download-only files, without embedded content or public URLs", async () => {
    const card = await projectCard({ ...capture, capture_channel: "email", capture_kind: "attachment" }, [], [
      { id: "a", filename: "photo.png", storage_state: "stored", observed_media_type: "image/png" },
      { id: "b", filename: "message.svg", storage_state: "stored", observed_media_type: "image/svg+xml" },
      { id: "c", filename: "missing.pdf", storage_state: "pending" },
    ], resolve);
    const html = render(card);
    expect(card.assets[0].raster).toBe(true); expect(card.assets[1].raster).toBe(false);
    expect(html).toContain("Preview unavailable"); expect(html).toContain('aria-label="Download photo.png"'); expect(html).toContain('aria-label="Download message.svg"');
    expect(html).not.toContain('aria-label="Download missing.pdf"'); expect(html).not.toMatch(/secret|<iframe|<embed|<svg|storage_path/);
  });
  it("requests private raster/download bytes with bearer authentication and no-store", async () => {
    const calls: unknown[] = [];
    const fetcher = (async (...args: unknown[]) => { calls.push(args); return new Response(new Blob(["private"])); }) as typeof fetch;
    expect(await (await requestPrivateAsset("c", "a", "token", false, fetcher)).text()).toBe("private");
    await requestPrivateAsset("c", "a", "token", true, fetcher);
    expect(calls).toEqual([["/api/revisit/assets/c/a", { headers: { Authorization: "Bearer token" }, cache: "no-store" }], ["/api/revisit/assets/c/a?download=1", { headers: { Authorization: "Bearer token" }, cache: "no-store" }]]);
    await expect(requestPrivateAsset("c", "a", "token", false, (async () => new Response(null, { status: 404 })) as typeof fetch)).rejects.toThrow("Attachment unavailable");
  });
  it("wraps long original text with accessible controls and handles absent fields", async () => {
    const card = await projectCard({ ...capture, raw_text: "x".repeat(20000), user_note: null, source_platform: null }, [], [], resolve);
    const html = render(card); expect(html).toContain("overflow-wrap:anywhere"); expect(html).toContain("min-width:0"); expect(html).toContain("max-width:100%"); expect(html).toContain('aria-label="Saved capture"'); expect(card.rawText).toHaveLength(16000);
  });
  it("formats supplied clock/timezone across day boundaries, future and malformed dates deterministically", () => {
    const saved = "2026-10-04T23:30:00Z", now = new Date("2026-10-05T00:30:00Z");
    expect(formatSavedDate(saved, now, "UTC")).toEqual({ absolute: "4 Oct 2026, 11:30 pm", relative: "1 hour ago" });
    expect(formatSavedDate(saved, now, "Australia/Sydney").absolute).toContain("5 Oct 2026");
    expect(formatSavedDate("bad", now, "UTC").absolute).toBe("Saved date unavailable");
    expect(formatSavedDate("2026-10-06T00:30:00Z", now, "UTC").relative).toBe("Just saved");
  });
});
