import { describe, expect, it, vi } from "vitest";
import { handleAsset, handleCard, type RevisitDependencies } from "./handler";
import { authenticateResearchRequest } from "../research/access";

const owner = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const request = (token = "owner", download = false) => new Request(`https://test.invalid/api/revisit/assets/${captureId}/${assetId}${download ? "?download=1" : ""}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
function fixture(type = "image/png", bytes = Buffer.from("89504e470d0a1a0a", "hex")) {
  const card = vi.fn(async () => ({ captureId, rawText: "Private note", note: "", kind: "image", channel: "whatsapp", source: "", savedAt: "2026-09-25T00:00:00Z", inferred: [], assets: [] }));
  const asset = vi.fn(async () => ({ bytes: new Blob([new Uint8Array(bytes)]), filename: 'private\r\nphoto.png', mediaType: type }));
  const storeFor = vi.fn(() => ({ card, asset }));
  const deps: RevisitDependencies = { authenticate: req => authenticateResearchRequest(req, { researchUserId: owner, resolveUser: async token => token === "owner" ? owner : token === "stranger" ? "other-user" : undefined }), storeFor };
  return { deps, card, asset, storeFor };
}
function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Authorization");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
describe("private card and attachment handlers", () => {
  it.each(["", "stranger", "invalid"])("AC4 discloses nothing to anonymous/wrong-user/invalid token %s", async token => {
    const f = fixture();
    for (const response of [await handleCard(request(token), captureId, f.deps), await handleAsset(request(token), captureId, assetId, f.deps)]) {
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "Unauthorized" }); privateHeaders(response);
    }
    expect(f.storeFor).not.toHaveBeenCalled();
  });
  it("AC4 uses the verified caller session and returns private no-store card data without storage URLs", async () => {
    const f = fixture(); const response = await handleCard(request(), captureId, f.deps);
    expect(response.status).toBe(200); privateHeaders(response);
    expect(f.storeFor).toHaveBeenCalledExactlyOnceWith({ userId: owner, accessToken: "owner" });
    expect(await response.json()).toMatchObject({ rawText: "Private note", captureId });
  });
  it("AC4 hides cross-owner or missing captures/assets and storage failures", async () => {
    const deps: RevisitDependencies = { authenticate: fixture().deps.authenticate, storeFor: () => ({ card: async () => undefined, asset: async () => undefined }) };
    for (const response of [await handleCard(request(), captureId, deps), await handleAsset(request(), captureId, assetId, deps)]) {
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "Unavailable" }); privateHeaders(response);
    }
    deps.storeFor = () => { throw new Error("secret storage path"); };
    const response = await handleCard(request(), captureId, deps); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret");
  });
  it.each([["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ff"], ["image/gif", "474946383961"], ["image/webp", "524946460000000057454250"]])("AC3 returns correct private raster bytes and MIME for %s", async (mime, hex) => {
    const bytes = Buffer.from(hex, "hex"); const response = await handleAsset(request(), captureId, assetId, fixture(mime, bytes).deps);
    expect(response.status).toBe(200); privateHeaders(response);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''privatephoto.png");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
  it.each(["image/svg+xml", "text/html", "application/pdf"])("AC3 never executes %s inline and offers inert authenticated download", async type => {
    const f = fixture(type, Buffer.from('<svg onload="alert(1)"></svg>'));
    const preview = await handleAsset(request(), captureId, assetId, f.deps); expect(preview.status).toBe(415); expect(await preview.text()).not.toContain("svg");
    const download = await handleAsset(request("owner", true), captureId, assetId, f.deps);
    expect(download.status).toBe(200); expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/); privateHeaders(download);
    expect(await download.text()).toContain("<svg");
  });
  it("AC5 rejects forged raster bytes, oversized previews and invalid identifiers without disclosure", async () => {
    for (const bytes of [Buffer.from("<html>secret</html>"), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
      const response = await handleAsset(request(), captureId, assetId, fixture("image/png", bytes).deps);
      expect(response.status).not.toBe(200); expect(await response.text()).not.toContain("secret");
    }
    const f = fixture();
    expect((await handleCard(request(), "../private", f.deps)).status).toBe(404);
    expect((await handleAsset(request(), captureId, "%2e%2e", f.deps)).status).toBe(404);
    expect(f.storeFor).not.toHaveBeenCalled();
  });
});
