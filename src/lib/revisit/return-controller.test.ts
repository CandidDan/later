import { describe, expect, it, vi } from "vitest";
import { createReturnController } from "./return-controller";
import type { CaptureCard } from "./card";
const card: CaptureCard = { captureId: "save", title: "An older save", rawText: "original", note: "my reason", kind: "link", channel: "email", source: "example.com", savedAt: "2025-01-01T00:00:00Z", inferred: [], assets: [], originalDestination: "https://example.com/original" };
const batch = (cards = [card]) => Response.json({ cards });
const applied = (destination = "https://example.com/checked") => Response.json({ status: "applied", destination });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
describe("later-0020 return behaviour", () => {
  it("AC1 fetches only the bounded authenticated return endpoint directly", async () => {
    const fetcher = vi.fn(async () => batch());
    const c = createReturnController(fetcher);
    await c.session(null); expect(fetcher).not.toHaveBeenCalled(); expect(c.snapshot().cards).toEqual([]);
    await c.session("authorised");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/revisit/batch", expect.objectContaining({ headers: { Authorization: "Bearer authorised" }, cache: "no-store" }));
    expect(c.snapshot().cards).toEqual([card]);
  });
  it.each([401, 403])("AC1 wrong-user or expired %s clears all visible private data", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce(new Response(null, { status }));
    const c = createReturnController(fetcher); await c.session("token"); await c.act("save", "consume");
    expect(c.snapshot()).toMatchObject({ phase: "signed_out", token: null, cards: [], pending: null });
    expect(c.snapshot().message).toContain("sign in again");
  });
  it("AC1 rejects late batches and actions after session expiry", async () => {
    const response = deferred<Response>();
    const c = createReturnController(async () => response.promise);
    const loading = c.session("token"); c.clear(); response.resolve(batch()); await loading;
    expect(c.snapshot().cards).toEqual([]);
    const actionResponse = deferred<Response>(), navigate = vi.fn();
    const other = createReturnController(vi.fn().mockResolvedValueOnce(batch()).mockReturnValueOnce(actionResponse.promise), navigate);
    await other.session("token"); const action = other.act("save", "open"); other.clear(); actionResponse.resolve(applied()); await action;
    expect(navigate).not.toHaveBeenCalled(); expect(other.snapshot().cards).toEqual([]);
  });
  it("AC3 persists before navigation, blocks duplicate clicks and never consumes on Open", async () => {
    const response = deferred<Response>(), navigate = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(batch()).mockReturnValueOnce(response.promise);
    const c = createReturnController(fetcher, navigate, () => "event-id"); await c.session("token");
    const action = c.act("save", "open"); await c.act("save", "consume");
    expect(fetcher).toHaveBeenCalledTimes(2); expect(navigate).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: "open", requestId: "event-id" });
    response.resolve(applied()); await action;
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://example.com/checked"); expect(c.snapshot().cards).toEqual([card]);
  });
  it("AC3 failed Open retains choices and retries the same persisted-event identity", async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(batch()).mockRejectedValueOnce(Error("network")).mockResolvedValueOnce(applied());
    const c = createReturnController(fetcher, navigate, () => "same-id"); await c.session("token"); await c.act("save", "open");
    expect(c.snapshot().cards).toEqual([card]); expect(c.snapshot().message).toContain("hasn't been confirmed"); expect(navigate).not.toHaveBeenCalled();
    await c.act("save", "open"); expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[2][1].body); expect(navigate).toHaveBeenCalledOnce();
  });
  it.each(["javascript:alert(1)", "http://example.com", "https://user:password@example.com"])("AC3 refuses an unsafe returned destination %s", async url => {
    const navigate = vi.fn(); const c = createReturnController(vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce(applied(url)), navigate);
    await c.session("token"); await c.act("save", "open"); expect(navigate).not.toHaveBeenCalled(); expect(c.snapshot().cards).toEqual([card]);
  });
  it.each(["defer", "consume"] as const)("AC4 %s removes only the chosen card and fetches nothing until Show a few more", async action => {
    const next = { ...card, captureId: "next" };
    const fetcher = vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce(applied()).mockResolvedValueOnce(batch([next]));
    const c = createReturnController(fetcher); await c.session("token"); await c.act("save", action);
    expect(c.snapshot().cards).toEqual([]); expect(c.snapshot().more).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    await c.load(); expect(c.snapshot().cards).toEqual([next]); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("AC4 token refresh preserves the current selection without automatic replacements", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(batch()).mockResolvedValueOnce(applied());
    const c = createReturnController(fetcher); await c.session("old"); await c.act("save", "defer"); await c.session("new", true);
    expect(c.snapshot()).toMatchObject({ token: "new", cards: [] }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("AC5 loading, empty and batch failure recover while retaining current choices", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(response.promise).mockRejectedValueOnce(Error("failure")).mockResolvedValueOnce(batch([]));
    const c = createReturnController(fetcher); const loading = c.session("token"); expect(c.snapshot().pending).toBe("batch");
    response.resolve(batch()); await loading; await c.load();
    expect(c.snapshot().cards).toEqual([card]); expect(c.snapshot().message).toContain("try again");
    await c.load(); expect(c.snapshot()).toMatchObject({ phase: "ready", cards: [], pending: null });
  });
  it("AC5 rejects oversized selections rather than exposing an archive", async () => {
    const c = createReturnController(async () => batch([card, card, card, card])); await c.session("token");
    expect(c.snapshot()).toMatchObject({ phase: "error", cards: [] });
  });
});
