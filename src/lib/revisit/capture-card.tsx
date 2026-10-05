"use client";
import React, { useEffect, useState } from "react";
import type { CaptureCard, CardAsset } from "./card";
import { formatSavedDate } from "./dates";

export async function requestPrivateAsset(captureId: string, assetId: string, accessToken: string, download: boolean, fetcher: typeof fetch = fetch): Promise<Blob> {
  const response = await fetcher(`/api/revisit/assets/${encodeURIComponent(captureId)}/${encodeURIComponent(assetId)}${download ? "?download=1" : ""}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!response.ok) throw new Error("Attachment unavailable");
  return response.blob();
}
function PrivateAttachment({ captureId, asset, accessToken }: { captureId: string; asset: CardAsset; accessToken: string }) {
  const [preview, setPreview] = useState<{ key: string; url: string }>();
  const [failed, setFailed] = useState(false);
  const key = `${captureId}/${asset.id}/${accessToken}`;
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (asset.available && asset.raster) {
      requestPrivateAsset(captureId, asset.id, accessToken, false).then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob); setPreview({ key, url: objectUrl });
      }).catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [captureId, asset.id, asset.available, asset.raster, accessToken, key]);
  async function download() {
    try {
      const blob = await requestPrivateAsset(captureId, asset.id, accessToken, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = asset.filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFailed(true); }
  }
  return <li>
    <p>{asset.filename || "Attachment"} · {asset.mediaType || "Unknown file type"}</p>
    {/* Private blob URLs are created only after a bearer-authenticated endpoint response. */}
    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated blob cannot use the public image optimizer */}
    {preview?.key === key && <img src={preview.url} alt={`Captured attachment: ${asset.filename}`} style={{ maxWidth: "100%", height: "auto" }} onError={() => { setPreview(undefined); setFailed(true); }} />}
    {(!asset.available || (asset.raster && preview?.key !== key)) && <p>Preview unavailable</p>}
    {asset.available && <button type="button" onClick={download} aria-label={`Download ${asset.filename || "attachment"}`}>Download attachment</button>}
    {failed && <p role="status">Attachment unavailable</p>}
  </li>;
}
/** Supply a clock and timezone so server/client rendering agrees across day boundaries. */
export function CaptureCardView({ card, accessToken, now, timeZone }: { card: CaptureCard; accessToken: string; now: Date; timeZone: string }) {
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
    {card.originalDestination && <a href={card.originalDestination} target="_blank" rel="noopener noreferrer">Open original</a>}
    {card.sourceDestination && card.sourceDestination !== card.originalDestination && <a href={card.sourceDestination} target="_blank" rel="noopener noreferrer">Open source</a>}
    {card.assets.length > 0 && <ul aria-label="Captured attachments">{card.assets.map(asset => <PrivateAttachment key={asset.id} captureId={card.captureId} asset={asset} accessToken={accessToken} />)}</ul>}
  </article>;
}
