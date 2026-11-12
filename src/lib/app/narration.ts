import { text, type Row } from "../revisit/card";
import { extractionReason, fullTextMetadata, platformKind, type OpenOriginalReason } from "./library";

export interface Narration {
  captureId: string; textVersion: string; title: string; byline: string | null; siteName: string | null;
  sourceUrl: string; intro: string; paragraphs: string[]; outro: string; wordCount: number;
}
export type NarrationOutcome = Narration | { status: "open_original"; reason: OpenOriginalReason };
/** Attribution is separate from the immutable source paragraphs. */
export function assembleNarration(captureId: string, extraction: Row | undefined, sourceUrl?: string): NarrationOutcome {
  const metadata = fullTextMetadata(extraction);
  if (sourceUrl && platformKind(sourceUrl)) return { status: "open_original", reason: "not_an_article" };
  if (!metadata) return { status: "open_original", reason: extractionReason(extraction) };
  if (!sourceUrl) return { status: "open_original", reason: "no_source" };
  if (!Array.isArray(extraction?.paragraphs) || !extraction.paragraphs.length || !extraction.paragraphs.every(p => typeof p === "string" && p.trim().length > 0)) throw new Error("Invalid narration");
  const title = text(extraction.title, 500) || new URL(sourceUrl).hostname;
  const byline = text(extraction.byline, 500) || null;
  const siteName = text(extraction.site_name, 500) || null;
  const source = siteName ?? new URL(sourceUrl).hostname;
  return { captureId, ...metadata, title, byline, siteName, sourceUrl,
    intro: `${title}. ${byline ? `By ${byline}. ` : ""}From ${source}. Narrated by Later.`,
    paragraphs: extraction.paragraphs as string[], outro: `End of ${title}, from ${source}.` };
}
