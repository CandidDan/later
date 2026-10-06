import { describe, expect, it, vi } from "vitest";
import { handleAction, handleBatch, type RevisitDependencies } from "./handler";
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const request = (input: unknown) => new Request("https://test.invalid", { method: "POST", body: JSON.stringify(input) });
function fixture(auth = true) {
  const batch = vi.fn(async () => []);
  const action = vi.fn(async () => ({ status: "applied" as const, repeated: false }));
  const deps: RevisitDependencies = { authenticate: async () => auth ? { userId: id, accessToken: "test" } : undefined, storeFor: () => ({ batch, action, card: vi.fn(), asset: vi.fn() }) };
  return { deps, batch, action };
}
describe("0019 authenticated return contracts", () => {
  it("AC7 empty batch is bounded explicit and private", async () => {
    const f = fixture(); const response = await handleBatch(request({}), f.deps);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "empty", cards: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["open", "defer", "consume"])("AC3 passes validated %s request ID to durable store", async action => {
    const f = fixture(); const response = await handleAction(request({ action, requestId }), id, f.deps);
    expect(response.status).toBe(200); expect(f.action).toHaveBeenCalledExactlyOnceWith(id, requestId, action);
  });
  it.each([{ action: "invalid", requestId }, { action: "open", requestId: "bad" }, {}, null])("AC6 invalid action fails before writes %j", async input => {
    const f = fixture(); expect((await handleAction(request(input), id, f.deps)).status).toBe(400); expect(f.action).not.toHaveBeenCalled();
  });
  it("AC6 anonymous batch and actions fail closed", async () => {
    const f = fixture(false); expect((await handleBatch(request({}), f.deps)).status).toBe(401); expect((await handleAction(request({ action: "consume", requestId }), id, f.deps)).status).toBe(401);
    expect(f.action).not.toHaveBeenCalled(); expect(f.batch).not.toHaveBeenCalled();
  });
  it("AC7 persistence failure returns error without content or private logging", async () => {
    const f = fixture(); const log = vi.spyOn(console, "error"); f.batch.mockRejectedValue(new Error("private credentials")); f.action.mockRejectedValue(new Error("private credentials"));
    for (const response of [await handleBatch(request({}), f.deps), await handleAction(request({ action: "defer", requestId }), id, f.deps)]) {
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Unavailable" });
    }
    expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
  it("AC7 unavailable Open is explicit", async () => {
    const f = fixture(); f.deps.storeFor = () => ({ batch: f.batch, card: vi.fn(), asset: vi.fn(), action: async () => ({ status: "unavailable" }) });
    const response = await handleAction(request({ action: "open", requestId }), id, f.deps); expect(response.status).toBe(409); expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
