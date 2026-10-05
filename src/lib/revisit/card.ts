import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "../resolution/metadata";
import { parseSourceResolutionResult, type SourceEvidence } from "../resolution/result";
import { isImageType } from "../assets/media";

export type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const text = (value: unknown, max = 2000): string => typeof value === "string" ? value.slice(0, max) : "";
export type ResolveHost = (host: string) => Promise<readonly { address: string }[]>;
/** Reuse the source resolver's public-address policy, without fetching any provider content. */
export async function safeDestination(value: unknown, resolve: ResolveHost = host => lookup(host, { all: true })): Promise<string | undefined> {
  try {
    const url = new URL(text(value));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/i.test(host)) return undefined;
    if (isIP(host) && !isPublicAddress(host)) return undefined;
    const addresses = await resolve(host);
    return addresses.length && addresses.every(a => isPublicAddress(a.address)) ? url.href : undefined;
  } catch { return undefined; }
}
export interface CardAsset { id: string; filename: string; mediaType: string; available: boolean; raster: boolean }
export interface CaptureCard {
  captureId: string; rawText: string; note: string; kind: string; channel: string; source: string;
  savedAt: string; title?: string; creator?: string; contentType?: string; durationSeconds?: number;
  inferred: string[]; originalDestination?: string; sourceDestination?: string; assets: CardAsset[];
}

export async function projectCard(capture: Row, runs: readonly Row[], assets: readonly Row[], resolve?: ResolveHost): Promise<CaptureCard> {
  const card: CaptureCard = {
    captureId: text(capture.id, 80), rawText: text(capture.raw_text, 16000), note: text(capture.user_note, 16000),
    kind: text(capture.capture_kind, 80) || "unknown", channel: text(capture.capture_channel, 80),
    source: text(capture.source_platform, 100), savedAt: text(capture.captured_at, 80), inferred: [],
    assets: assets.slice(0, 30).map(a => ({ id: text(a.id, 80), filename: text(a.filename, 255), mediaType: text(a.observed_media_type || a.media_type, 100), available: a.storage_state === "stored", raster: isImageType(text(a.observed_media_type)) })),
  };
  const candidates = (card.rawText.match(/https?:\/\/[^\s<>"']+/g) ?? []).slice(0, 8);
  for (const candidate of candidates) {
    const destination = await safeDestination(candidate, resolve);
    if (destination) { card.originalDestination = destination; card.source ||= new URL(destination).hostname; break; }
  }
  const run = runs.filter(r => r.analysis_type === "source_resolution" && r.status === "succeeded" && Number.isFinite(Date.parse(text(r.created_at))))
    .sort((a,b) => Date.parse(text(b.created_at)) - Date.parse(text(a.created_at)) || (text(a.id) < text(b.id) ? 1 : text(a.id) > text(b.id) ? -1 : 0))[0];
  if (!run) return card;
  const snapshot = record(run.input_snapshot);
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence.filter(e => {
    const r = record(e); return typeof r.id === "string" && typeof r.kind === "string" && typeof r.value === "string";
  }) as SourceEvidence[] : [];
  // Metadata is factual even when resolution is unresolved; take one document, never merge runs/documents.
  const metadata = record(Array.isArray(snapshot.publicMetadata) ? snapshot.publicMetadata[0] : undefined);
  const supported = (kind: string, value: unknown) => typeof value === "string" && evidence.some(e => e.kind === kind && e.value === value);
  if (supported("metadata_title", metadata.title)) card.title = text(metadata.title, 500);
  if (supported("metadata_creator", metadata.creator)) card.creator = text(metadata.creator, 500);
  if (supported("metadata_duration", String(metadata.durationSeconds)) && Number.isSafeInteger(metadata.durationSeconds) && Number(metadata.durationSeconds) > 0) card.durationSeconds = Number(metadata.durationSeconds);
  card.contentType = text(metadata.contentType, 100) || undefined;
  try {
    const result = parseSourceResolutionResult(run.result, evidence);
    if (result.status === "resolved") {
      card.title ||= text(result.title, 500); card.creator ||= text(result.creator, 500);
      card.durationSeconds ??= result.durationSeconds ?? undefined;
      card.sourceDestination = await safeDestination(result.canonicalUrl, resolve);
      if (!card.contentType) { card.contentType = result.sourceType; card.inferred.push("contentType"); }
      card.source ||= card.sourceDestination ? new URL(card.sourceDestination).hostname : "";
    }
  } catch { /* Malformed enrichment leaves the capture usable. */ }
  return card;
}

