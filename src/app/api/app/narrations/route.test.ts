import { describe, expect, it } from "vitest";
import { handleNarration } from "../../../../lib/app/handler";
import { appFixture, captureId, foreignId, fullExtraction, owner, request } from "../../../../lib/app/test-fixture";
function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Authorization");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
describe("app narration route", () => {
  it.each(["", "invalid", "stranger"])("AC8 rejects %s token before exposure", async token => {
    const f = appFixture(); const response = await handleNarration(request(`narrations/${captureId}`, token), captureId, f.deps);
    expect(response.status).toBe(401); privateHeaders(response);
    expect(f.storeFor).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.exposed.size).toBe(0);
  });
  it.each([foreignId, "55555555-5555-4555-8555-555555555555", "../bad"])("AC3 foreign, missing or invalid id %s returns 404 without disclosure or exposure", async id => {
    const f = appFixture(); const response = await handleNarration(request(`narrations/${id}`), id, f.deps);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "Unavailable" }); privateHeaders(response);
    expect(f.from).not.toHaveBeenCalled(); expect(f.exposed.size).toBe(0);
  });
  it("AC4 records exposure before reading text, preserves paragraphs exactly and returns separate attribution and version", async () => {
    const f = appFixture(); const response = await handleNarration(request(`narrations/${captureId}`), captureId, f.deps);
    expect(response.status).toBe(200); privateHeaders(response);
    expect(f.calls).toEqual(["rpc:revisit_expose", "read:capture_article_extractions"]);
    expect(f.exposed.has(captureId)).toBe(true);
    expect(f.storeFor).toHaveBeenCalledWith({ userId: owner, accessToken: "owner" });
    expect(f.queries[0]).toMatchObject({ filters: { capture_id: captureId, user_id: owner }, orders: ["created_at", "id"], limit: 1 });
    expect(await response.json()).toEqual({ captureId, textVersion: "a".repeat(64), title: "An article", byline: "A Writer", siteName: "Example", sourceUrl: "https://example.com/article", intro: "An article. By A Writer. From Example. Narrated by Later.", paragraphs: fullExtraction().paragraphs, outro: "End of An article, from Example.", wordCount: 250 });
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
  });
  it.each([["partial", "paywalled"], ["partial", "truncated"], ["unsupported", "not_an_article"], ["unsupported", "not_html"], ["unsupported", "too_short"], ["unsupported", "extraction_failed"], ["failed", "fetch_failed"], ["failed", "extraction_failed"]])("AC5 %s/%s returns exact reason without any paragraphs", async (status, reason) => {
    const f = appFixture({ extractions: [{ ...fullExtraction(), status, reason, paragraphs: null, content_sha256: null }] });
    const response = await handleNarration(request(`narrations/${captureId}`), captureId, f.deps);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: "open_original", reason });
    expect(f.exposed.has(captureId)).toBe(true); expect(response.headers.has("etag")).toBe(false); privateHeaders(response);
  });
  it("AC5 no extraction is open_original/no_source, still exposed", async () => {
    const f = appFixture({ extractions: [] }); const response = await handleNarration(request(`narrations/${captureId}`), captureId, f.deps);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: "open_original", reason: "no_source" });
    expect(f.exposed.has(captureId)).toBe(true); privateHeaders(response);
  });
  it("uses the latest outcome instead of reviving older full text", async () => {
    const f = appFixture({ extractions: [fullExtraction(), { ...fullExtraction(), id: "newest", created_at: "2026-11-13T00:00:00Z", status: "partial", reason: "paywalled", paragraphs: null }] });
    const response = await handleNarration(request(`narrations/${captureId}`), captureId, f.deps);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: "open_original", reason: "paywalled" });
  });
  it("AC9 exposure and storage errors fail closed with private generic 503", async () => {
    for (const failure of ["exposure", "storage"]) {
      const f = appFixture();
      if (failure === "exposure") f.rpc.mockResolvedValue({ data: true, error: new Error("private details") });
      else f.from.mockImplementation(() => { throw new Error("private details"); });
      const response = await handleNarration(request(`narrations/${captureId}`), captureId, f.deps);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Unavailable" }); privateHeaders(response);
      if (failure === "exposure") expect(f.from).not.toHaveBeenCalled();
    }
  });
  it("never returns a conditional 304 without recording exposure for the request", async () => {
    const f = appFixture(); const req = request(`narrations/${captureId}`); req.headers.set("If-None-Match", `"${"a".repeat(64)}"`);
    expect((await handleNarration(req, captureId, f.deps)).status).toBe(200); expect(f.rpc).toHaveBeenCalledOnce();
  });
});
