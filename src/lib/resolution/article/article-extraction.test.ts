import { readFileSync } from "node:fs";
import { Readability } from "@mozilla/readability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MetadataError, type MetadataRequest, type MetadataResponse } from "../metadata";
import { ARTICLE_MAX_BYTES, ARTICLE_MIN_WORDS, extractArticle } from "./extract";
import { decodeHtml, extractFromUrl, fetchArticleDocument } from "./process";

const URL_UNDER_TEST = "https://example.com/essay";
const fullArticle = readFileSync(new URL("./fixtures/full-article.html", import.meta.url), "utf8");
const shortPage = readFileSync(new URL("./fixtures/short-page.html", import.meta.url), "utf8");

/** The fixture article's own text, block by block, exactly as written in the HTML. */
const ARTICLE_TEXT = [
  "By Ada Example",
  "Every background system eventually loses a worker in the middle of a job. The process is killed, the machine is recycled, or a deploy lands at exactly the wrong moment. What matters is not whether this happens, but what the system remembers when it does.",
  "A durable queue stores the job before anyone starts it. The claim is a row update with a lease, and the lease has an expiry. If the worker vanishes, the lease runs out and another worker can pick the job up again. Nothing is lost, because nothing was ever only in memory.",
  "Fencing the second attempt",
  "The subtle part is the late worker. A worker that was merely slow, not dead, may come back after its lease expired and try to publish a result. Each claim therefore carries an attempt number, and finishing requires presenting the same number. A stale attempt is quietly refused, so two workers can never both publish an answer for one job.",
  "Retries are cheap; duplicate side effects are not.",
  "Bounded retries keep failures honest. After three attempts the job is marked terminal and the reason is recorded from a closed list, so an operator can tell a network outage from a page that was simply never going to work. A failed row is evidence, and it should be kept rather than deleted to make a dashboard look green.",
  "None of this is new. It is the same discipline that payment systems and mail servers have used for decades, and it remains the simplest way to make background work trustworthy when the machines underneath it are not. Start with the queue, and the rest follows from there.",
];

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

function served(body: Uint8Array | string, contentType = "text/html; charset=utf-8"): MetadataResponse {
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  };
}

function fetchVia(request: MetadataRequest) {
  return (url: string) => fetchArticleDocument(url, { resolveHostname: publicResolver, request });
}

function withHead(markup: string): string {
  return fullArticle.replace("</head>", `${markup}\n</head>`);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("article extraction", () => {
  it("full article is verbatim and ordered", async () => {
    const request = vi.fn<MetadataRequest>(async () => served(fullArticle));
    const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(request));

    expect(extraction.status).toBe("full");
    expect(extraction.reason).toBeNull();
    expect(extraction.paragraphs).toStrictEqual(ARTICLE_TEXT);
    expect(extraction.paragraphs!.join("\n\n")).toBe(ARTICLE_TEXT.join("\n\n"));
    expect(extraction.wordCount).toBeGreaterThanOrEqual(ARTICLE_MIN_WORDS);
    expect(extraction).toMatchObject({
      sourceUrl: URL_UNDER_TEST,
      title: "Why durable queues outlive their workers",
      byline: "Ada Example",
      siteName: "Example Engineering",
      language: "en-GB",
    });
    // Navigation and footer chrome is dropped, never inserted; the page's script never ran.
    const text = extraction.paragraphs!.join(" ");
    for (const chrome of ["Archive", "Related", "All rights reserved", "rewritten by a script"]) {
      expect(text).not.toContain(chrome);
    }
    // One request for the document itself: no stylesheet or other subresource was fetched.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2]).toBe(ARTICLE_MAX_BYTES);
  });

  it.each([
    ["JSON-LD isAccessibleForFree: false",
      '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>'],
    ["JSON-LD hasPart isAccessibleForFree: \"False\"",
      '<script type="application/ld+json">{"@graph":[{"@type":"Article","hasPart":{"@type":"WebPageElement","isAccessibleForFree":"False","cssSelector":".rest"}}]}</script>'],
    ["article:content_tier locked", '<meta property="article:content_tier" content="locked">'],
    ["article:content_tier metered", '<meta property="article:content_tier" content="Metered">'],
  ])("paywall signal %s yields partial/paywalled with no paragraphs", (_label, markup) => {
    const extraction = extractArticle(withHead(markup), URL_UNDER_TEST);
    expect(extraction).toMatchObject({ status: "partial", reason: "paywalled", paragraphs: null });
  });

  it.each([
    ["class paywall", '<div class="article-paywall">Subscribe to keep reading</div>'],
    ["id regwall", '<div id="regwall-prompt"></div>'],
    ["class subscriber-only", '<section class="subscriber-only"></section>'],
    ["class premium-content", '<div class="Premium-Content"></div>'],
  ])("paywall element %s yields partial/paywalled with no paragraphs", (_label, markup) => {
    const extraction = extractArticle(fullArticle.replace("</article>", `${markup}</article>`), URL_UNDER_TEST);
    expect(extraction).toMatchObject({ status: "partial", reason: "paywalled", paragraphs: null });
  });

  it("a body cut by the 2 MiB cap yields partial/truncated with no paragraphs", async () => {
    const padded = fullArticle.replace("</body>", `<!-- ${"x".repeat(ARTICLE_MAX_BYTES)} --></body>`);
    const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(async () => served(padded)));
    expect(extraction).toMatchObject({ status: "partial", reason: "truncated", paragraphs: null, wordCount: null });
  });

  it("a declared length over the cap yields partial/truncated before the body is read", async () => {
    const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(async () => {
      throw new MetadataError("metadata_too_large");
    }));
    expect(extraction).toMatchObject({ status: "partial", reason: "truncated", paragraphs: null });
  });

  it("a 150-word page yields unsupported/too_short with no paragraphs", async () => {
    const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(async () => served(shortPage)));
    expect(extraction).toMatchObject({ status: "unsupported", reason: "too_short", paragraphs: null });
    expect(extraction.wordCount).toBeLessThan(ARTICLE_MIN_WORDS);
  });

  it.each(["application/pdf", "text/plain; charset=utf-8", "application/json"])(
    "a non-HTML %s response yields unsupported/not_html with no paragraphs",
    async (contentType) => {
      const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(async () => served(fullArticle, contentType)));
      expect(extraction).toMatchObject({ status: "unsupported", reason: "not_html", paragraphs: null });
    },
  );

  it("Readability finding no article yields unsupported/extraction_failed with no paragraphs", () => {
    vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
    expect(extractArticle(fullArticle, URL_UNDER_TEST))
      .toMatchObject({ status: "unsupported", reason: "extraction_failed", paragraphs: null });
  });

  it("a page with no readable text yields unsupported/extraction_failed", () => {
    expect(extractArticle("<!doctype html><html><body></body></html>", URL_UNDER_TEST))
      .toMatchObject({ status: "unsupported", reason: "extraction_failed", paragraphs: null });
  });

  it("bytes that do not decode as declared are never guessed at", async () => {
    const invalid = new Uint8Array([...new TextEncoder().encode(fullArticle), 0xff, 0xfe]);
    const extraction = await extractFromUrl(URL_UNDER_TEST, fetchVia(async () => served(invalid)));
    expect(extraction).toMatchObject({ status: "unsupported", reason: "extraction_failed", paragraphs: null });
  });

  it("a declared non-UTF-8 charset decodes the article faithfully", () => {
    const latin = fullArticle.replace("<meta charset=\"utf-8\">", "").replace("Fencing", "Café fencing");
    const bytes = Uint8Array.from(latin, (character) => character.charCodeAt(0));
    expect(decodeHtml({ body: bytes, charset: "iso-8859-1" })).toBe(latin);
    const sniffed = latin.replace("<head>", '<head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">');
    expect(decodeHtml({ body: Uint8Array.from(sniffed, (c) => c.charCodeAt(0)) })).toBe(sniffed);
    expect(decodeHtml({ body: bytes, charset: "not-a-charset" })).toBeUndefined();
  });
});
