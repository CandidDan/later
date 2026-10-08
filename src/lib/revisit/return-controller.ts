import type { CaptureCard } from "./card";
import type { RevisitAction } from "./store";

export interface ReturnState {
  phase: "loading" | "signed_out" | "ready" | "error";
  cards: CaptureCard[];
  token: string | null;
  pending: string | null;
  message: string;
  more: boolean;
}
export const INITIAL_RETURN_STATE: ReturnState = {
  phase: "loading", cards: [], token: null, pending: null, message: "", more: false,
};
const SESSION_MESSAGE = "Your session ended or cannot access these saves. Please sign in again.";

/** One session generation owns all async results. Retries reuse their event identity. */
export function createReturnController(
  fetcher: typeof fetch = fetch,
  navigate: (url: string) => void = url => window.location.assign(url),
  newId: () => string = () => crypto.randomUUID(),
) {
  let state = INITIAL_RETURN_STATE;
  let generation = 0;
  const listeners = new Set<() => void>();
  const attempts = new Map<string, string>();
  const publish = (patch: Partial<ReturnState>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  function clear(message = SESSION_MESSAGE) {
    generation++;
    attempts.clear();
    publish({ ...INITIAL_RETURN_STATE, phase: "signed_out", message });
  }
  async function request(path: string, token: string, body?: unknown) {
    const response = await fetcher(path, {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403) throw Error("session");
    if (!response.ok) throw Error("unavailable");
    return response.json();
  }
  async function load() {
    if (!state.token || state.pending) return;
    const token = state.token, epoch = generation;
    publish({ pending: "batch", message: "" });
    try {
      const payload = await request("/api/revisit/batch", token);
      if (epoch !== generation) return;
      if (!Array.isArray(payload.cards) || payload.cards.length > 3) throw Error("unavailable");
      publish({ phase: "ready", cards: payload.cards, pending: null, more: true });
    } catch (error) {
      if (epoch !== generation) return;
      if ((error as Error).message === "session") clear();
      else publish({ phase: state.phase === "ready" ? "ready" : "error", pending: null,
        message: "We couldn't load your saves. Please try again." });
    }
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear,
    unavailable() { clear(""); publish({ phase: "error", message: "Sign-in is unavailable. Please try again." }); },
    async session(token: string | null, refresh = false) {
      if (token === state.token && token) return;
      if (token && refresh && state.token && state.phase === "ready") {
        generation++;
        publish({ token, pending: null, message: state.pending ? "Your choice hasn't been confirmed as saved. Please retry the same action." : state.message });
        return;
      }
      clear(state.token ? SESSION_MESSAGE : "");
      if (!token) return;
      publish({ phase: "loading", token });
      await load();
    },
    load,
    async act(captureId: string, action: RevisitAction) {
      if (!state.token || state.pending || !state.cards.some(card => card.captureId === captureId)) return;
      const token = state.token, epoch = generation;
      const key = `${captureId}/${action}`;
      const requestId = attempts.get(key) ?? newId();
      attempts.set(key, requestId);
      publish({ pending: captureId, message: "Saving your choice…" });
      try {
        const outcome = await request(`/api/revisit/actions/${encodeURIComponent(captureId)}`, token, { action, requestId });
        if (epoch !== generation) return;
        if (outcome.status !== "applied") throw Error("unavailable");
        if (action === "open") {
          const url = new URL(outcome.destination);
          if (url.protocol !== "https:" || url.username || url.password) throw Error("unavailable");
          navigate(url.href);
          publish({ pending: null, message: "Opened original. This item stays available until you choose otherwise." });
        } else {
          publish({ cards: state.cards.filter(card => card.captureId !== captureId), pending: null, more: true,
            message: action === "defer" ? "Saved for another time. Hidden for seven days." : "Marked as already consumed." });
        }
        attempts.delete(key);
      } catch (error) {
        if (epoch !== generation) return;
        if ((error as Error).message === "session") clear();
        else publish({ pending: null, message: "Your choice hasn't been confirmed as saved. Please retry the same action." });
      }
    },
  };
}
