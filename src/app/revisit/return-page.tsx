"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { browserSupabaseClient } from "../../lib/supabase/browser";
import { createReturnController, INITIAL_RETURN_STATE } from "../../lib/revisit/return-controller";
import { MAGIC_LINK_FAILURE_MESSAGE, requestResearchMagicLink } from "../research/auth";
import { watchReturnSession } from "../../lib/revisit/return-session";
import { buttonClass, ReturnSelection } from "./views";

export default function ReturnPage() {
  const [controller] = useState(() => createReturnController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, () => INITIAL_RETURN_STATE);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [authAttempt, setAuthAttempt] = useState(0);
  const submitting = useRef(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const priorCount = useRef(0);
  useEffect(() => {
    try { return watchReturnSession(browserSupabaseClient().auth, controller); }
    catch { controller.unavailable(); }

  }, [controller, authAttempt]);
  useEffect(() => {
    if (state.phase === "ready" && state.cards.length < priorCount.current) moreButton.current?.focus();
    priorCount.current = state.cards.length;
  }, [state.phase, state.cards.length]);
  async function signIn(form: FormData) {
    if (submitting.current) return;
    submitting.current = true; setSending(true); setMessage("");
    try {
      const ok = await requestResearchMagicLink(browserSupabaseClient().auth, String(form.get("email") || ""), window.location.origin, "/revisit");
      setSent(ok); if (!ok) setMessage(MAGIC_LINK_FAILURE_MESSAGE);
    } catch { setMessage(MAGIC_LINK_FAILURE_MESSAGE); }
    finally { submitting.current = false; setSending(false); }
  }
  if (state.phase === "signed_out") return <section className="min-w-0">
    <p role="status">{message || state.message}</p>
    {sent ? <><p role="status">Check your email for a sign-in link. Open it to come back to your saves.</p><button className={buttonClass} onClick={() => setSent(false)}>Send another link</button></> :
      <form action={signIn} className="flex min-w-0 flex-col gap-4" aria-label="Sign in to your saves" aria-busy={sending}>
        <p>Sign in with your authorised account to see your saved items.</p>
        <label htmlFor="return-email">Email address</label>
        <input className="min-w-0 max-w-full rounded border p-3" id="return-email" name="email" type="email" autoComplete="email" required disabled={sending} />
        <button className={buttonClass} disabled={sending}>{sending ? "Sending link…" : "Email me a sign-in link"}</button>
        {sending && <p role="status">Sending your sign-in link…</p>}
      </form>}
  </section>;
  return <ReturnSelection state={state} act={controller.act} load={() => {
    if (!state.token) setAuthAttempt(value => value + 1); else void controller.load();
  }} focusRef={moreButton} expired={controller.clear} />;
}
