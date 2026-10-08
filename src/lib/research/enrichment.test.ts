import { describe, expect, it, vi } from "vitest";
import { handleResearchEnrichment, type ResearchEnrichmentDependencies } from "./enrichment";
import type { ResearchStore } from "./types";
import type { RevisitStore } from "../revisit/store";
import { requestPrivateAsset } from "../revisit/capture-card";

const captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = { userId: "owner", accessToken: "token" };
function fixture() {
  const revealRuns = vi.fn<ResearchStore["revealRuns"]>().mockResolvedValue({ status: "recall_required" });
  const card = vi.fn<RevisitStore["card"]>().mockResolvedValue({ captureId, rawText: "original", title: "Fetched title", note: "", kind: "image", channel: "email", source: "example", savedAt: "2026-01-01", assets: [], inferred: [] });
  const asset = vi.fn<RevisitStore["asset"]>().mockResolvedValue({ bytes: new Blob(["private bytes"]), filename: "original.pdf", mediaType: "application/pdf" });
  const revisitStoreFor = vi.fn<ResearchEnrichmentDependencies["revisitStoreFor"]>(() => ({ card, asset }) as unknown as RevisitStore);
  const deps: ResearchEnrichmentDependencies = { authenticate: vi.fn(async () => session), storeFor: () => ({ revealRuns }) as unknown as ResearchStore, revisitStoreFor };
  return { deps, revealRuns, card, asset, revisitStoreFor };
}
const request = () => new Request("https://later.test/api/research/assets/unused?download=1");
describe("later-0021 server enrichment recall boundary", () => {
  it.each([undefined, assetId])("AC1/5 rejects direct authenticated requests before durable recall: %s", async id => {
    const f = fixture();
    const response = await handleResearchEnrichment(request(), captureId, id, f.deps);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "recall_required" });
    expect(f.revisitStoreFor).not.toHaveBeenCalled(); expect(f.card).not.toHaveBeenCalled(); expect(f.asset).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([undefined, assetId])("AC2 delegates to exposure-enforcing owned store only after confirmed recall: %s", async id => {
    const f = fixture(); const order: string[] = [];
    f.revealRuns.mockImplementation(async received => { expect(received).toBe(captureId); order.push("recall"); return { status: "revealed", captureId, runs: [] }; });
    f.revisitStoreFor.mockImplementation(received => { expect(received).toEqual(session); order.push("enrichment"); return { card: f.card, asset: f.asset } as unknown as RevisitStore; });
    const response = await handleResearchEnrichment(request(), captureId, id, f.deps);
    expect(response.status).toBe(200); expect(order).toEqual(["recall", "enrichment"]);
    if (id) { expect(await response.text()).toBe("private bytes"); expect(f.asset).toHaveBeenCalledWith(captureId, assetId); }
    else { expect((await response.json()).title).toBe("Fetched title"); expect(f.card).toHaveBeenCalledWith(captureId); }
  });
  it("AC5 rejects unauthenticated, invalid and failed-recall requests without enrichment", async () => {
    const f = fixture();
    const unauth = { ...f.deps, authenticate: async () => undefined };
    expect((await handleResearchEnrichment(request(), captureId, undefined, unauth)).status).toBe(401);
    expect(f.revealRuns).not.toHaveBeenCalled();
    expect((await handleResearchEnrichment(request(), "invalid", undefined, f.deps)).status).toBe(400);
    f.revealRuns.mockRejectedValue(Error("private database details"));
    const failed = await handleResearchEnrichment(request(), captureId, undefined, f.deps);
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private database details");
    expect(f.revisitStoreFor).not.toHaveBeenCalled();
  });
  it("AC4 enrichment failure remains a neutral failed optional request", async () => {
    const f = fixture(); f.revealRuns.mockResolvedValue({ status: "revealed", captureId, runs: [] });
    f.card.mockRejectedValue(Error("private card data"));
    const response = await handleResearchEnrichment(request(), captureId, undefined, f.deps);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private card data");
  });
  it("AC1/2 routes research preview and download bytes through guarded research endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Blob(["bytes"])));
    await requestPrivateAsset(captureId, assetId, "token", false, fetcher, "research");
    await requestPrivateAsset(captureId, assetId, "token", true, fetcher, "research");
    expect(fetcher.mock.calls[0][0]).toBe(`/api/research/reveal?view=asset&captureId=${captureId}&assetId=${assetId}`);
    expect(fetcher.mock.calls[1][0]).toBe(`/api/research/reveal?view=asset&captureId=${captureId}&assetId=${assetId}&download=1`);
  });
});
