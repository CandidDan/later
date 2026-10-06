import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));
import { createRevisitStore } from "./store";
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function fixture(rawText = "https://example.com/article") {
  const rpc = vi.fn(async (name: string) => ({ data: name === "revisit_batch" ? [id] : name === "revisit_expose" ? true : { status: "applied", action: "open", destination: "https://example.com/article", repeated: false }, error: null }));
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: table === "captures" ? { id, raw_text: rawText } : null, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(done),
    }; return query;
  });
  return { rpc, from, store: createRevisitStore({ from, rpc } as unknown as SupabaseClient, id) };
}
describe("0019 persisted batch/actions store", () => {
  it("AC1/AC2 batch waits for atomic eligibility/exposure before reading rich cards", async () => {
    const f = fixture(); let persist!: () => void;
    f.rpc.mockImplementationOnce(async () => { await new Promise<void>(resolve => { persist = resolve; }); return { data: [id], error: null }; });
    const pending = f.store.batch(); expect(f.from).not.toHaveBeenCalled(); persist();
    expect(await pending).toMatchObject([{ captureId: id, originalDestination: "https://example.com/article" }]);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("revisit_batch");
  });
  it("AC7 batch persistence failure cannot release rich content", async () => {
    const f = fixture(); f.rpc.mockRejectedValue(new Error("private")); await expect(f.store.batch()).rejects.toThrow(); expect(f.from).not.toHaveBeenCalled();
  });
  it("AC3 Open uses available validated destination and records exposure and attempt separately", async () => {
    const f = fixture(); expect(await f.store.action(id,requestId,"open")).toMatchObject({ status: "applied", destination: "https://example.com/article" });
    expect(f.rpc.mock.calls.map(c => c[0])).toEqual(["revisit_expose", "revisit_action"]);
    expect(f.rpc).toHaveBeenLastCalledWith("revisit_action", { p_capture_id:id,p_request_id:requestId,p_action:"open",p_destination:"https://example.com/article" });
  });
  it.each(["http://example.com", "https://127.0.0.1/a", "https://user:pass@example.com/a", "text only"])("AC3/AC7 unavailable destination %s cannot create Open event", async value => {
    const f = fixture(value); expect(await f.store.action(id,requestId,"open")).toEqual({ status: "unavailable" }); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("AC3 untrusted persisted Open destination is revalidated before return", async () => {
    const f = fixture(); f.rpc.mockImplementation(async name => ({ data: name === "revisit_expose" ? true : { status: "applied", destination: "https://127.0.0.1/private" }, error: null }) as never);
    expect(await f.store.action(id,requestId,"open")).toEqual({ status: "unavailable" });
  });
  it("AC3 deferral delegates server timestamp and request identity without reading/releasing content", async () => {
    const f = fixture(); await f.store.action(id,requestId,"defer"); expect(f.from.mock.calls.map(c=>c[0])).toEqual(["capture_revisit_events"]);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith("revisit_action", { p_capture_id:id,p_request_id:requestId,p_action:"defer",p_destination:null });
  });
});
