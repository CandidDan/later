import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createRevisitStore, ownedObjectPath } from "./store";

const owner = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const path = `captures/${owner}/${captureId}/photo.png`;
function fixture(options: { owner?: string; state?: string; path?: string; error?: boolean; missing?: boolean } = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => { filters[field] = value; calls.push([table, field, value]); return query; }),
      order: vi.fn(() => query), limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (options.error) return { error: new Error("private database details"), data: null };
        if (table === "captures") return { data: filters.id === captureId && filters.user_id === (options.owner ?? owner) ? { id: captureId, raw_text: "An older WhatsApp note", capture_kind: "text", captured_at: "2026-09-25T00:00:00Z" } : null };
        return { data: filters.capture_id === captureId && filters.id === assetId ? { filename: "photo.png", storage_path: options.path ?? path, storage_state: options.state ?? "stored", observed_media_type: "image/png" } : null };
      }),
      then: (done: (value: unknown) => unknown) => Promise.resolve({ data: [], error: options.error ? new Error("private") : null }).then(done),
    };
    return query;
  });
  const download = vi.fn(async () => ({ data: options.missing ? null : new Blob(["private image"]), error: null }));
  const bucket = vi.fn(() => ({ download }));
  const client = { from, storage: { from: bucket } } as unknown as SupabaseClient;
  return { store: createRevisitStore(client, owner), from, bucket, download, calls };
}
describe("caller-scoped revisit store", () => {
  it("AC4 scopes card and asset lookup to owner before reading any child records or bytes", async () => {
    const f = fixture({ owner: "another-user" });
    expect(await f.store.card(captureId)).toBeUndefined();
    expect(await f.store.asset(captureId, assetId)).toBeUndefined();
    expect(f.from.mock.calls).toEqual([["captures"], ["captures"]]);
    expect(f.calls).toContainEqual(["captures", "user_id", owner]);
    expect(f.download).not.toHaveBeenCalled();
  });
  it("AC1 returns capture-only projection while requesting bounded deterministic successful source runs", async () => {
    const f = fixture();
    expect(await f.store.card(captureId)).toMatchObject({ captureId, rawText: "An older WhatsApp note", assets: [] });
    const runQuery = f.from.mock.results[1].value;
    expect(runQuery.order.mock.calls).toEqual([["created_at", { ascending: false }], ["id", { ascending: false }]]);
    expect(runQuery.limit).toHaveBeenCalledWith(1);
    expect(f.calls).toContainEqual(["capture_analyses", "status", "succeeded"]);
    expect(f.calls).toContainEqual(["capture_analyses", "analysis_type", "source_resolution"]);
    expect(f.from.mock.results[2].value.limit).toHaveBeenCalledWith(30);
  });
  it("AC3 downloads only the exact stored owned object from the private bucket", async () => {
    const f = fixture(); const asset = await f.store.asset(captureId, assetId);
    expect(await asset?.bytes.text()).toBe("private image");
    expect(asset).toMatchObject({ filename: "photo.png", mediaType: "image/png" });
    expect(f.bucket).toHaveBeenCalledExactlyOnceWith("capture-assets");
    expect(f.download).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.calls).toContainEqual(["capture_assets", "capture_id", captureId]);
    expect(f.calls).toContainEqual(["capture_assets", "id", assetId]);
    expect(await f.store.asset(captureId, "other-asset")).toBeUndefined();
  });
  it.each(["pending", "failed", "missing"])("AC3 does not download %s assets", async state => {
    const f = fixture({ state }); expect(await f.store.asset(captureId, assetId)).toBeUndefined(); expect(f.download).not.toHaveBeenCalled();
  });
  it("AC3 handles missing private bytes and fails closed on database errors", async () => {
    expect(await fixture({ missing: true }).store.asset(captureId, assetId)).toBeUndefined();
    await expect(fixture({ error: true }).store.card(captureId)).rejects.toThrow("Capture unavailable");
  });
  it.each([`captures/other/${captureId}/photo.png`, `captures/${owner}/other/photo.png`, `${path}/else`, `captures/${owner}/${captureId}/../secret`, `captures/${owner}/${captureId}/%2e%2e`, `captures/${owner}/${captureId}/a\\b`, `captures/${owner}/${captureId}/`, `captures/${owner}/${captureId}/..`, `captures/${owner}/${captureId}/a\u0000b`])("AC5 prevents path escape: %s", async storagePath => {
    expect(ownedObjectPath(storagePath, owner, captureId)).toBe(false);
    const f = fixture({ path: storagePath }); expect(await f.store.asset(captureId, assetId)).toBeUndefined(); expect(f.download).not.toHaveBeenCalled();
  });
});
