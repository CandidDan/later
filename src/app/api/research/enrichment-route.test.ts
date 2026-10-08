import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ deps: {}, handler: vi.fn(async () => new Response(null, { status: 409 })) }));
vi.mock("@/lib/research/enrichment", () => ({ handleResearchEnrichment: state.handler }));
vi.mock("@/lib/research/enrichment-server", () => ({ createResearchEnrichmentDependencies: () => state.deps }));
vi.mock("@/lib/research/server", () => ({ createResearchDependencies: () => state.deps }));
vi.mock("@/lib/research/handler", () => import("../../../lib/research/handler"));
import { GET } from "./reveal/route";
describe("research enrichment routes", () => {
  it("AC1/5 both card and asset route requests use the recall guard", async () => {
    const request = new Request("https://later.test/api/research/reveal?view=card&captureId=capture");
    expect((await GET(request)).status).toBe(409);
    expect(state.handler).toHaveBeenLastCalledWith(request, "capture", undefined, state.deps);
    const assetRequest = new Request("https://later.test/api/research/reveal?view=asset&captureId=capture&assetId=asset");
    expect((await GET(assetRequest)).status).toBe(409);
    expect(state.handler).toHaveBeenLastCalledWith(assetRequest, "capture", "asset", state.deps);
  });
});
