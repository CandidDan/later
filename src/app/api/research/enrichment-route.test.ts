import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ deps: {}, handler: vi.fn(async () => new Response(null, { status: 409 })) }));
vi.mock("@/lib/research/enrichment", () => ({ handleResearchEnrichment: state.handler }));
vi.mock("@/lib/research/enrichment-server", () => ({ createResearchEnrichmentDependencies: () => state.deps }));
import { GET as card } from "./cards/[captureId]/route";
import { GET as asset } from "./assets/[captureId]/[assetId]/route";
describe("research enrichment routes", () => {
  it("AC1/5 both card and asset route requests use the recall guard", async () => {
    const request = new Request("https://later.test/api/research/cards/capture");
    expect((await card(request, { params: Promise.resolve({ captureId: "capture" }) })).status).toBe(409);
    expect(state.handler).toHaveBeenLastCalledWith(request, "capture", undefined, state.deps);
    expect((await asset(request, { params: Promise.resolve({ captureId: "capture", assetId: "asset" }) })).status).toBe(409);
    expect(state.handler).toHaveBeenLastCalledWith(request, "capture", "asset", state.deps);
  });
});
