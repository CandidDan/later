"use client";
import React, { useEffect, useRef, useState } from "react";
import type { CaptureCard, CardAsset } from "./card";
import { formatSavedDate } from "./dates";

export async function requestPrivateAsset(captureId: string, assetId: string, accessToken: string, download: boolean, fetcher: typeof fetch = fetch, surface: "revisit" | "research" = "revisit"): Promise<Blob> {
  const response = await fetcher(`/api/${surface}/assets/${encodeURIComponent(captureId)}/${encodeURIComponent(assetId)}${download ? "?download=1" : ""}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "session" : "Attachment unavailable");
  return response.blob();
}
/** A preview owns its temporary URL until cleanup, including when a request settles late. */
export function startPrivatePreview(captureId: string, assetId: string, accessToken: string, ready: (url: string) => void, failed: (error?: Error) => void, fetcher: typeof fetch = fetch, surface: "revisit" | "research" = "revisit"): () => void {
  let active = true;
  let objectUrl: string | undefined;
  requestPrivateAsset(captureId, assetId, accessToken, false, fetcher, surface).then(blob => {
    if (!active) return;
    objectUrl = URL.createObjectURL(blob);
    ready(objectUrl);
  }).catch(error => { if (active) failed(error); });
  return () => { active = false; if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; } };
}
function PrivateAttachment({ captureId, asset, accessToken, onSessionExpired, assetSurface }: { captureId: string; asset: CardAsset; accessToken: string; assetSurface: "revisit" | "research"; onSessionExpired?(): void }) {
  const [preview, setPreview] = useState<{ key: string; url: string }>();
  const [failed, setFailed] = useState<string>();
  const [retry, setRetry] = useState(0);
  const downloading = useRef(false);
  const [pending, setPending] = useState(false);
  const key = `${captureId}/${asset.id}/${accessToken}`;
  useEffect(() => {
    if (asset.available && asset.raster) {
      return startPrivatePreview(captureId, asset.id, accessToken,
        url => setPreview({ key, url }), error => { setFailed(key); if (error?.message === "session") onSessionExpired?.(); }, fetch, assetSurface);
    }
  }, [captureId, asset.id, asset.available, asset.raster, accessToken, key, retry, onSessionExpired, assetSurface]);
  async function download() {
    if (downloading.current) return;
    downloading.current = true; setPending(true);
    try {
      const blob = await requestPrivateAsset(captureId, asset.id, accessToken, true, fetch, assetSurface);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = asset.filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setFailed(key); if ((error as Error).message === "session") onSessionExpired?.(); }
    finally { downloading.current = false; setPending(false); }
  }
  return <li>
    <p>{asset.filename || "Attachment"} · {asset.mediaType || "Unknown file type"}</p>
    {/* Private blob URLs are created only after a bearer-authenticated endpoint response. */}
    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated blob cannot use the public image optimizer */}
    {preview?.key === key && <img src={preview.url} alt={`Captured attachment: ${asset.filename}`} style={{ maxWidth: "100%", height: "auto" }} onError={() => { setPreview(undefined); setFailed(key); }} />}
    {(!asset.available || (asset.raster && preview?.key !== key)) && <p>Preview unavailable</p>}
    {asset.available && <button type="button" onClick={download} disabled={pending} aria-label={`Download ${asset.filename || "attachment"}`}>Download attachment</button>}
    {failed === key && <><p role="status">Attachment unavailable. You can retry without changing your saved item.</p>{asset.available && asset.raster && <button type="button" onClick={() => { setFailed(undefined); setRetry(value => value + 1); }}>Retry preview</button>}</>}
  </li>;
}
/** Supply a clock and timezone so server/client rendering agrees across day boundaries. */
export function CaptureCardView({ card, accessToken, now, timeZone, hideDestinations = false, onSessionExpired, assetSurface = "revisit" }: { card: CaptureCard; accessToken: string; now: Date; timeZone: string; hideDestinations?: boolean; assetSurface?: "revisit" | "research"; onSessionExpired?(): void }) {
  const date = formatSavedDate(card.savedAt, now, timeZone);
  const inferred = (field: string) => card.inferred.includes(field) ? " (inferred)" : "";
  return <article aria-label="Saved capture" style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}>
    <h2>{card.title || card.source || `${card.kind} capture`}{inferred("title")}</h2>
    {card.creator && <p>{card.creator}{inferred("creator")}</p>}
    <p>{card.source || "Source unavailable"} · {card.kind} · {card.channel}</p>
    {card.contentType && <p>{card.contentType}{inferred("contentType")}</p>}
    {card.durationSeconds !== undefined && <p>{card.durationSeconds} seconds{inferred("durationSeconds")}</p>}
    <p><time dateTime={card.savedAt}>{date.absolute}</time>{date.relative && ` · ${date.relative}`}</p>
    {card.rawText && <p style={{ whiteSpace: "pre-wrap" }}>{card.rawText}</p>}
    {card.note && card.note !== card.rawText && <p style={{ whiteSpace: "pre-wrap" }}>{card.note}</p>}
    {!hideDestinations && card.originalDestination && <a href={card.originalDestination} target="_blank" rel="noopener noreferrer">Open original</a>}
    {!hideDestinations && card.sourceDestination && card.sourceDestination !== card.originalDestination && <a href={card.sourceDestination} target="_blank" rel="noopener noreferrer">Open source</a>}
    {card.assets.length > 0 && <ul aria-label="Captured attachments">{card.assets.map(asset => <PrivateAttachment assetSurface={assetSurface} key={asset.id} captureId={card.captureId} asset={asset} accessToken={accessToken} onSessionExpired={onSessionExpired} />)}</ul>}
  </article>;
}
