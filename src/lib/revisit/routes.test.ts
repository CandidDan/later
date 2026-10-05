import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), store: vi.fn(), card: vi.fn(), asset: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../supabase/server", () => ({ createUserScopedClient: mocks.client }));
vi.mock("./store", () => ({ createRevisitStore: mocks.store }));
vi.mock("@/lib/revisit/handler", () => import("./handler"));
vi.mock("@/lib/revisit/server", () => import("./server"));
const owner = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("RESEARCH_USER_ID", owner);
  mocks.client.mockImplementation((token: string) => ({ token, auth: { getUser: vi.fn(async () => ({ data: { user: token === "owner-token" ? { id: owner } : { id: "another-user" } }, error: null })) } }));
  mocks.store.mockReturnValue({ card: mocks.card, asset: mocks.asset });
  mocks.card.mockResolvedValue({ captureId, rawText: "Private original" });
  mocks.asset.mockResolvedValue({ bytes: new Blob([new Uint8Array([255, 216, 255])]), filename: "photo.jpg", mediaType: "image/jpeg" });
});
afterEach(() => vi.unstubAllEnvs());
async function routes(token?: string) {
  const card = await import("../../app/api/revisit/cards/[captureId]/route");
  const asset = await import("../../app/api/revisit/assets/[captureId]/[assetId]/route");
  const request = new Request("https://test.invalid/api/revisit", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return [await card.GET(request, { params: Promise.resolve({ captureId }) }), await asset.GET(request, { params: Promise.resolve({ captureId, assetId }) })];
}
describe("revisit route authentication and wiring", () => {
  it.each([undefined, "stranger-token"])("AC4 actual card/asset endpoints reject %s before constructing a store", async token => {
    for (const response of await routes(token)) { expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "Unauthorized" }); }
    expect(mocks.store).not.toHaveBeenCalled(); expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.asset).not.toHaveBeenCalled();
    if (!token) expect(mocks.client).not.toHaveBeenCalled();
  });
  it("AC4 endpoints fail closed when the v0 user is unconfigured or token verification fails", async () => {
    vi.stubEnv("RESEARCH_USER_ID", "");
    for (const response of await routes("owner-token")) expect(response.status).toBe(401);
    expect(mocks.client).not.toHaveBeenCalled();
    vi.stubEnv("RESEARCH_USER_ID", owner);
    mocks.client.mockReturnValue({ auth: { getUser: async () => ({ data: { user: null }, error: new Error("secret auth details") }) } });
    for (const response of await routes("owner-token")) { expect(response.status).toBe(401); expect(await response.text()).not.toContain("secret"); }
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("AC3/AC4 verifies bearer tokens and binds both stores to the caller client; serves private card and raster", async () => {
    const [card, asset] = await routes("owner-token");
    expect(await card.json()).toEqual({ captureId, rawText: "Private original" });
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(Buffer.from([255, 216, 255]));
    expect(asset.headers.get("content-type")).toBe("image/jpeg");
    for (const response of [card, asset]) expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.card).toHaveBeenCalledExactlyOnceWith(captureId);
    expect(mocks.asset).toHaveBeenCalledExactlyOnceWith(captureId, assetId);
    for (const [client, user] of mocks.store.mock.calls) { expect(user).toBe(owner); expect(client.token).toBe("owner-token"); }
    expect(mocks.client.mock.calls).toEqual(Array(4).fill(["owner-token"]));
    for (const index of [0, 2]) expect(mocks.client.mock.results[index].value.auth.getUser).toHaveBeenCalledExactlyOnceWith("owner-token");
  });
});
