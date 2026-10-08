import type { Ref } from "react";
import { CaptureCardView } from "../../lib/revisit/capture-card";
import type { ReturnState } from "../../lib/revisit/return-controller";
import type { RevisitAction } from "../../lib/revisit/store";
export const buttonClass = "rounded-lg border border-zinc-400 px-4 py-3 text-left disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4";
export function ReturnSelection({ state, act, load, focusRef, expired }: {
  state: ReturnState; act(id: string, action: RevisitAction): void; load(): void; focusRef?: Ref<HTMLButtonElement>; expired?(): void;
}) {
  return <section aria-label="Saved items" aria-busy={!!state.pending} className="flex min-w-0 flex-col gap-6" style={{ overflowWrap: "anywhere" }}>
    <p role="status" aria-live="polite">{state.message || (state.pending === "batch" ? "Loading your saves…" : "")}</p>
    {state.phase === "loading" && !state.pending && <p role="status">Loading your saves…</p>}
    {state.phase === "ready" && !state.cards.length && <p>Nothing to bring back right now.</p>}
    {state.cards.map(card => <div key={card.captureId} className="min-w-0 rounded-xl border border-zinc-300 p-4">
      <CaptureCardView card={card} accessToken={state.token!} now={new Date()} timeZone="UTC" hideDestinations onSessionExpired={expired} />
      <p id={`delay-${card.captureId}`} className="my-3 text-sm">Another time hides this item for seven days.</p>
      <div role="group" aria-label={`Choices for ${card.title || card.source || "saved item"}`} className="flex flex-wrap gap-3">
        <button className={buttonClass} disabled={!!state.pending || !(card.originalDestination || card.sourceDestination)} onClick={() => act(card.captureId, "open")}>Open original</button>
        <button className={buttonClass} disabled={!!state.pending} aria-describedby={`delay-${card.captureId}`} onClick={() => act(card.captureId, "defer")}>Another time</button>
        <button className={buttonClass} disabled={!!state.pending} onClick={() => act(card.captureId, "consume")}>Already consumed</button>
      </div>
    </div>)}
    {(state.more || state.phase === "error") && <button ref={focusRef} className={buttonClass} disabled={!!state.pending} onClick={load}>{state.phase === "error" ? "Try again" : "Show a few more"}</button>}
  </section>;
}
