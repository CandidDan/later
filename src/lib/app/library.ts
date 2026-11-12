import { projectCard, text, type CaptureCard, type ResolveHost, type Row } from "../revisit/card";
import type { ArticleExtractionReason } from "../resolution/article/extract";

export type OpenOriginalReason = ArticleExtractionReason | "no_source";
export type LibraryKind = "article" | "video" | "audio" | "post" | "text" | "other";
export type ListenState =
  | { state: "narratable"; wordCount: number; textVersion: string }
  | { state: "preparing" }
  | { state: "open_original"; reason: OpenOriginalReason };
export interface LibraryItem {
  captureId: string;
  title: string | null;
  creator: string | null;
  source: string | null;
  sourceUrl: string | null;
  savedAt: string;
  kind: LibraryKind;
  listen: ListenState;
}
const reasons: readonly string[] = ["not_an_article", "paywalled", "truncated", "too_short", "not_html", "extraction_failed", "fetch_failed"];
export function extractionReason(extraction?: Row): OpenOriginalReason {
  return reasons.includes(text(extraction?.reason)) ? extraction!.reason as ArticleExtractionReason : "no_source";
}

/** Platform pages are never articles, including when an earlier analysis misclassified one. */
export function platformKind(url: string | undefined, source = ""): "video" | "audio" | "post" | undefined {
  let host = source.toLowerCase();
  try { if (url) host = new URL(url).hostname.toLowerCase(); } catch { /* No URL is not a platform match. */ }
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("youtube.com") || is("youtu.be") || is("tiktok.com") || ["youtube", "tiktok"].includes(host)) return "video";
  if (is("spotify.com") || is("podcasts.apple.com") || is("podcasts.google.com") || is("overcast.fm") || is("pca.st") || host === "spotify") return "audio";
  if (is("instagram.com") || is("x.com") || is("twitter.com") || ["instagram", "x", "twitter"].includes(host)) return "post";
  return undefined;
}
function kindOf(card: CaptureCard, extraction?: Row): LibraryKind {
  const platform = platformKind(card.sourceDestination ?? card.originalDestination, card.source);
  if (platform) return platform;
  if (card.contentType === "youtube_video" || card.contentType?.startsWith("video/") || card.kind === "video") return "video";
  if (["spotify_episode", "spotify_show", "podcast_episode"].includes(card.contentType ?? "") || card.contentType?.startsWith("audio/") || card.kind === "audio") return "audio";
  if (card.contentType === "article" || extraction?.status === "full") return "article";
  if (card.kind === "text" && !card.sourceDestination && !card.originalDestination) return "text";
  return "other";
}
export function fullTextMetadata(extraction?: Row): { wordCount: number; textVersion: string } | undefined {
  if (extraction?.status !== "full" || !Number.isSafeInteger(extraction.word_count) || Number(extraction.word_count) < 200 || !/^[a-f0-9]{64}$/.test(text(extraction.content_sha256))) return undefined;
  return { wordCount: Number(extraction.word_count), textVersion: String(extraction.content_sha256) };
}
export async function projectLibraryItem(
  capture: Row, runs: readonly Row[], extraction: Row | undefined, jobs: readonly Row[], resolve?: ResolveHost,
): Promise<LibraryItem> {
  const card = await projectCard(capture, runs, [], resolve);
  const kind = kindOf(card, extraction);
  const metadata = fullTextMetadata(extraction);
  let listen: ListenState;
  if (["video", "audio", "post"].includes(kind)) listen = { state: "open_original", reason: "not_an_article" };
  else if (metadata) listen = { state: "narratable", ...metadata };
  else if (jobs.some(job => job.job_type === "article_extraction" && ["pending", "processing"].includes(text(job.status)))) listen = { state: "preparing" };
  // Intent completion may intentionally enqueue no resolution job (for example a plain note).
  // Only queued or active work is evidence that preparation is still underway.
  else if (!extraction && jobs.some(job => ["pending", "processing"].includes(text(job.status)))) listen = { state: "preparing" };
  else listen = { state: "open_original", reason: extractionReason(extraction) };
  return {
    captureId: card.captureId, title: card.title ?? null, creator: card.creator ?? null,
    source: card.source || null, sourceUrl: card.sourceDestination ?? card.originalDestination ?? null,
    savedAt: card.savedAt, kind, listen,
  };
}
