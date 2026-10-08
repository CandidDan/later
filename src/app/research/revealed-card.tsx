"use client";
import { useEffect, useState } from "react";
import type { CaptureCard } from "../../lib/revisit/card";
import { CaptureCardView } from "../../lib/revisit/capture-card";

/** Mount only in the confirmed reveal phase. Cleanup discards responses from prior screens. */
export function RevealedCard({ captureId, accessToken }: { captureId: string; accessToken: string }) {
  const [card, setCard] = useState<CaptureCard>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void fetch(`/api/revisit/cards/${encodeURIComponent(captureId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) return;
      const value = await response.json() as CaptureCard;
      if (active && value.captureId === captureId && Array.isArray(value.assets) && Array.isArray(value.inferred)) setCard(value);
    }).catch(() => { /* This enhancement must never take away the rating controls. */ });
    return () => { active = false; controller.abort(); };
  }, [captureId, accessToken]);
  return card ? <CaptureCardView card={card} accessToken={accessToken} now={new Date()} timeZone="UTC" />
    : <p role="status">Rich capture preview unavailable. You can still rate the interpretations below.</p>;
}
