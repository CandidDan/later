import type { createReturnController } from "./return-controller";
type Session = { access_token: string; expires_at?: number } | null;
export interface ReturnAuth {
  getSession(): Promise<{ data: { session: Session }; error?: unknown }>;
  onAuthStateChange(callback: (event: string, session: Session) => void): { data: { subscription: { unsubscribe(): void } } };
}
/** Timers and auth events clear private data even without another API request. */
export function watchReturnSession(auth: ReturnAuth, controller: ReturnType<typeof createReturnController>) {
  let active = true, observed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function accept(session: Session, refresh = false) {
    if (!active) return;
    clearTimeout(timer);
    if (session?.expires_at && session.expires_at * 1000 <= Date.now()) { controller.clear(); return; }
    void controller.session(session?.access_token ?? null, refresh);
    if (session?.expires_at) timer = setTimeout(() => controller.clear(), session.expires_at * 1000 - Date.now());
  }
  const { data } = auth.onAuthStateChange((event, session) => { observed = true; accept(session, event === "TOKEN_REFRESHED"); });
  void auth.getSession().then(({ data, error }) => {
    if (!active || observed) return;
    if (error) controller.clear(); else accept(data.session);
  }).catch(() => { if (active) controller.unavailable(); });
  return () => { active = false; clearTimeout(timer); data.subscription.unsubscribe(); controller.clear(""); };
}
