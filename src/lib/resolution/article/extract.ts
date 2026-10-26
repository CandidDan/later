import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

import type { ArticleExtractionRecordInput } from "../../jobs/types";
import { boundedMetadataText } from "../metadata";

/** Bump whenever classification or paragraph splitting changes what a stored row means. */
export const ARTICLE_EXTRACTOR_VERSION = "article-extraction-v1";
export const ARTICLE_MAX_BYTES = 2 * 1024 * 1024;
export const ARTICLE_TIMEOUT_MS = 10_000;
export const ARTICLE_MAX_REDIRECTS = 3;
export const ARTICLE_MIN_WORDS = 200;

/** The closed reason list. Every non-`full` outcome is exactly one of these literals. */
export const ARTICLE_EXTRACTION_REASONS = [
  "not_an_article",
  "not_html",
  "too_short",
  "paywalled",
  "truncated",
  "extraction_failed",
  "fetch_failed",
] as const;

export type ArticleExtractionReason = (typeof ARTICLE_EXTRACTION_REASONS)[number];

export type ArticleExtraction = Omit<ArticleExtractionRecordInput, "captureId">;

const PAYWALL_MARKER = /paywall|regwall|subscriber-only|premium-content/iu;
const LOCKED_TIERS = new Set(["locked", "metered"]);
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/u;

/**
 * Elements that end one paragraph and begin the next. Inline elements (links, emphasis, spans)
 * never split text, so a sentence with a link in it stays one paragraph.
 */
const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** An outcome that stores nothing but its honest reason. */
export function withoutText(
  status: "partial" | "unsupported",
  reason: ArticleExtractionReason,
  sourceUrl: string | null,
  wordCount: number | null = null,
): ArticleExtraction {
  return {
    status, reason, sourceUrl, title: null, byline: null, siteName: null, language: null,
    paragraphs: null, wordCount, extractorVersion: ARTICLE_EXTRACTOR_VERSION,
  };
}

function inertDocument(html: string, url: string): Document {
  // Scripts never run and no subresource is ever requested; parse diagnostics stay out of logs.
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() }).window.document;
}

function lockedByJsonLd(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(lockedByJsonLd);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "isAccessibleForFree"
      ? entry === false || (typeof entry === "string" && entry.trim().toLowerCase() === "false")
      : lockedByJsonLd(entry));
}

/** Any one publisher signal that the served body may not be the whole article. */
export function hasPaywallSignal(document: Document): boolean {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      if (lockedByJsonLd(JSON.parse(script.textContent ?? ""))) return true;
    } catch {
      // Malformed structured data is not evidence either way.
    }
  }
  for (const meta of document.querySelectorAll("meta[property], meta[name]")) {
    const name = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? "").toLowerCase();
    if (name === "article:content_tier"
        && LOCKED_TIERS.has((meta.getAttribute("content") ?? "").trim().toLowerCase())) return true;
  }
  for (const element of document.querySelectorAll("[class], [id]")) {
    if (PAYWALL_MARKER.test(element.getAttribute("class") ?? "")
        || PAYWALL_MARKER.test(element.getAttribute("id") ?? "")) return true;
  }
  return false;
}

/** Split readable HTML into its text blocks verbatim, in source order. Whitespace is normalised only. */
export function paragraphsOf(contentHtml: string, url: string): string[] {
  const root = inertDocument(`<!doctype html><body>${contentHtml}</body>`, url).body;
  const paragraphs: string[] = [];
  let buffer = "";
  const flush = () => {
    const text = buffer.replace(/\s+/gu, " ").trim();
    if (text.length > 0) paragraphs.push(text);
    buffer = "";
  };
  const visit = (node: Node) => {
    if (node.nodeType === node.TEXT_NODE) {
      buffer += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const block = BLOCK_ELEMENTS.has((node as Element).tagName);
    if (block) flush();
    for (const child of node.childNodes) visit(child);
    if (block) flush();
  };
  visit(root);
  flush();
  return paragraphs;
}

export function countWords(paragraphs: readonly string[]): number {
  return paragraphs.reduce(
    (total, paragraph) => total + paragraph.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length,
    0,
  );
}

function language(value: string | null | undefined): string | null {
  const tag = value?.trim();
  return tag && LANGUAGE_TAG.test(tag) ? tag : null;
}

/**
 * Classify one complete, untruncated HTML document. Conservative by design: anything short of
 * the whole readable article is reported as not narratable, and never carries text.
 */
export function extractArticle(html: string, url: string): ArticleExtraction {
  let parsed: ReturnType<Readability<string>["parse"]>;
  let documentLanguage: string | null = null;
  try {
    const document = inertDocument(html, url);
    if (hasPaywallSignal(document)) return withoutText("partial", "paywalled", url);
    documentLanguage = document.documentElement.getAttribute("lang");
    parsed = new Readability(document).parse();
  } catch {
    return withoutText("unsupported", "extraction_failed", url);
  }
  if (!parsed?.content) return withoutText("unsupported", "extraction_failed", url);

  const paragraphs = paragraphsOf(parsed.content, url);
  if (paragraphs.length === 0) return withoutText("unsupported", "extraction_failed", url);
  const wordCount = countWords(paragraphs);
  if (wordCount < ARTICLE_MIN_WORDS) return withoutText("unsupported", "too_short", url, wordCount);

  return {
    status: "full",
    reason: null,
    sourceUrl: url,
    title: boundedMetadataText(parsed.title) ?? null,
    byline: boundedMetadataText(parsed.byline) ?? null,
    siteName: boundedMetadataText(parsed.siteName) ?? null,
    language: language(parsed.lang) ?? language(documentLanguage),
    paragraphs,
    wordCount,
    extractorVersion: ARTICLE_EXTRACTOR_VERSION,
  };
}
