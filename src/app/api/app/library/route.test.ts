import { describe, expect, it, vi } from "vitest";
import { handleLibrary } from "../../../../lib/app/handler";
import { appFixture, captureId, foreignId, owner, request } from "../../../../lib/app/test-fixture";
import { decodeCursor, encodeCursor } from "../../../../lib/app/cursor";
function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Authorization");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
describe("app library route", () => {
  it.each(["", "invalid", "stranger"])("AC8 rejects %s token without invoking the exposing RPC", async token => {
    const f = appFixture(); const response = await handleLibrary(request("library", token), f.deps);
    expect(response.status).toBe(401); privateHeaders(response); expect(f.storeFor).not.toHaveBeenCalled(); expect(f.exposed.size).toBe(0);
  });
  it("AC1/AC3 reads only an exposed owned page and never releases raw private payloads", async () => {
    const f = appFixture(); const response = await handleLibrary(request("library"), f.deps);
    expect(response.status).toBe(200); privateHeaders(response);
    const body = await response.json(); expect(body.items).toHaveLength(1); expect(body.nextCursor).toBeNull();
    expect(f.exposed.has(foreignId)).toBe(false);
    expect(f.calls[0]).toBe("rpc:app_library_page");
    expect(f.queries.find(q => q.table === "captures")?.filters.user_id).toBe(owner);
    expect(f.queries.find(q => q.table === "capture_article_extractions")?.columns).not.toContain("paragraphs");
    expect(JSON.stringify(body)).not.toMatch(/raw_text|rawText|paragraphs|PRIVATE other/);
  });
  it("AC6 completed plain-note intent without a source job is open_original/no_source through the route", async () => {
    const f = appFixture({
      captures: [{ id: captureId, user_id: owner, raw_text: "Remember to buy tea", capture_kind: "text", captured_at: "2026-11-12T00:00:00Z" }],
      extractions: [], runs: [],
      jobs: [{ id: "intent-1", capture_id: captureId, job_type: "intent_analysis", status: "completed", created_at: "2026-11-12T00:00:01Z" }],
    });
    const response = await handleLibrary(request("library"), f.deps);
    expect(response.status).toBe(200); privateHeaders(response);
    expect(await response.json()).toMatchObject({ items: [{ captureId, kind: "text", sourceUrl: null, listen: { state: "open_original", reason: "no_source" } }], nextCursor: null });
    expect(f.exposed.has(captureId)).toBe(true);
  });
  it("AC7 pages 120 captures in disjoint newest-first pages, excludes consumed, includes deferred, and ends with null", async () => {
    const captures = Array.from({ length: 120 }, (_, n) => ({ id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`, user_id: owner, raw_text: "note", capture_kind: "text", captured_at: `2026-11-12T00:00:00.${String(n).padStart(6, "0")}+00:00`, consumed_at: n === 119 ? "2026-11-12T01:00:00Z" : null, deferred_until: n === 118 ? "2027-01-01T00:00:00Z" : null }));
    const f = appFixture({ captures, extractions: [], runs: [] });
    let cursor: string | null = null; const ids: string[] = []; const sizes: number[] = [];
    do {
      const response = await handleLibrary(request(`library?limit=50${cursor ? `&before=${cursor}` : ""}`), f.deps);
      expect(response.status).toBe(200); privateHeaders(response);
      const body = await response.json(); sizes.push(body.items.length); ids.push(...body.items.map((item: { captureId: string }) => item.captureId)); cursor = body.nextCursor;
      if (cursor) expect(decodeCursor(cursor).capturedAt).toContain(".000");
      expect(sizes.length).toBeLessThan(4);
    } while (cursor);
    expect(sizes).toEqual([50, 50, 19]); expect(new Set(ids).size).toBe(119);
    expect(ids).toEqual(captures.slice(0, 119).reverse().map(c => c.id));
    expect(f.exposed.size).toBe(119); expect(f.exposed.has(captures[119].id)).toBe(false);
  });
  it.each(["before=bad", "before=", "before=%2F", "limit=NaN", "limit=1.5", "limit=", "limit=1&limit=2", "before=bad&before=worse"])("rejects malformed query %s before exposure", async query => {
    const f = appFixture(); const response = await handleLibrary(request(`library?${query}`), f.deps);
    expect(response.status).toBe(400); privateHeaders(response); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([["0", 1], ["-1", 1], ["100", 50], ["2", 2]])("clamps limit %s to %s", async (limit, expected) => {
    const f = appFixture(); expect((await handleLibrary(request(`library?limit=${limit}`), f.deps)).status).toBe(200);
    expect(f.rpc).toHaveBeenCalledWith("app_library_page", { p_before: null, p_before_id: null, p_limit: expected });
  });
  it("preserves microsecond cursor and UUID tie-breaker in the RPC arguments", async () => {
    const f = appFixture(); const before = { capturedAt: "2026-11-12T00:00:00.000001+00:00", captureId: foreignId };
    await handleLibrary(request(`library?before=${encodeCursor(before)}`), f.deps);
    expect(f.rpc).toHaveBeenCalledWith("app_library_page", { p_before: before.capturedAt, p_before_id: foreignId, p_limit: 50 });
  });
  it("AC9 exposure failure discloses no partial page and includes all private headers", async () => {
    const f = appFixture(); f.rpc.mockResolvedValue({ data: [], error: new Error("private database details") });
    const response = await handleLibrary(request("library"), f.deps);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Unavailable" }); privateHeaders(response); expect(f.from).not.toHaveBeenCalled();
  });
});

const routeDependencies = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/app/server", () => ({ createAppDependencies: routeDependencies.get }));
vi.mock("@/lib/app/handler", () => import("../../../../lib/app/handler"));
import { GET, runtime, dynamic } from "./route";
it("wires the dynamic Node route to the authenticated handler", async () => {
  const f = appFixture(); routeDependencies.get.mockReturnValue(f.deps);
  const response = await GET(request("library"));
  expect(response.status).toBe(200); privateHeaders(response);
  expect(runtime).toBe("nodejs"); expect(dynamic).toBe("force-dynamic"); expect(f.storeFor).toHaveBeenCalledOnce();
});
