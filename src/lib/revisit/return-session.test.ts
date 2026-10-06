import { afterEach, describe, expect, it, vi } from "vitest";
import { watchReturnSession, type ReturnAuth } from "./return-session";
import { createReturnController } from "./return-controller";
afterEach(() => vi.useRealTimers());
describe("later-0020 live auth lifecycle", () => {
  it("AC1 session completes directly, expiry clears private data without a request, cleanup unsubscribes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let event!: Parameters<ReturnAuth["onAuthStateChange"]>[0]; const unsubscribe = vi.fn();
    const auth: ReturnAuth = { getSession: async () => ({ data: { session: null } }), onAuthStateChange: callback => { event = callback; return { data: { subscription: { unsubscribe } } }; } };
    const fetcher = vi.fn(async () => Response.json({ cards: [{ captureId: "private" }] }));
    const controller = createReturnController(fetcher); const stop = watchReturnSession(auth, controller);
    event("SIGNED_IN", { access_token: "token", expires_at: Date.now() / 1000 + 5 });
    await vi.advanceTimersByTimeAsync(0); expect(controller.snapshot().cards).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000); expect(controller.snapshot()).toMatchObject({ phase: "signed_out", cards: [], token: null });
    expect(fetcher).toHaveBeenCalledOnce(); stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("AC1 sign-out supersedes a stale getSession and never resurrects private content", async () => {
    let resolve!: (result: Awaited<ReturnType<ReturnAuth["getSession"]>>) => void;
    let event!: Parameters<ReturnAuth["onAuthStateChange"]>[0];
    const auth: ReturnAuth = { getSession: () => new Promise(r => { resolve = r; }), onAuthStateChange: callback => { event = callback; return { data: { subscription: { unsubscribe() {} } } }; } };
    const fetcher = vi.fn(); const controller = createReturnController(fetcher); const stop = watchReturnSession(auth, controller);
    event("SIGNED_OUT", null); resolve({ data: { session: { access_token: "stale" } } }); await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled(); expect(controller.snapshot().cards).toEqual([]); stop();
  });
});
