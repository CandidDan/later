import type { ArticleExtractionJobStore, StoredSourceAnalysis } from "../../jobs/types";
import {
  fetchPublicDocument,
  MetadataError,
  type MetadataFetchOptions,
  type PublicDocument,
} from "../metadata";
import { platformMetadataRoute } from "../platform";
import { recognizeSource } from "../recognized";
import {
  ARTICLE_MAX_BYTES,
  ARTICLE_MAX_REDIRECTS,
  ARTICLE_TIMEOUT_MS,
  extractArticle,
  withoutText,
  type ArticleExtraction,
} from "./extract";

export type ArticleExtractionOutcome =
  | { status: "idle" }
  | {
      status: "succeeded";
      jobId: string;
      captureId: string;
      extractionId: string;
      extraction: ArticleExtraction["status"];
    }
  | { status: "failed"; jobId: string; captureId: string; errorCode: string };

export type ArticleDocumentFetcher = (url: string) => Promise<PublicDocument>;

export interface ProcessArticleExtractionDependencies {
  store: ArticleExtractionJobStore;
  fetchDocument?: ArticleDocumentFetcher;
}

/**
 * Hosts whose pages are players, feeds or apps rather than articles. They are never fetched as
 * articles even if a source analysis mislabels one; the outcome is recorded as not narratable.
 */
const NON_ARTICLE_HOSTS = [
  "youtube.com", "youtu.be", "spotify.com", "instagram.com", "x.com", "twitter.com",
  "tiktok.com", "podcasts.apple.com", "podcasts.google.com", "overcast.fm", "pca.st",
];

/** Exactly the shared SSRF-safe fetcher, narrowed to complete HTML within the article budget. */
export function fetchArticleDocument(url: string, options: MetadataFetchOptions = {}): Promise<PublicDocument> {
  return fetchPublicDocument(url, ["text/html"], {
    ...options,
    maximumBytes: ARTICLE_MAX_BYTES,
    timeoutMs: ARTICLE_TIMEOUT_MS,
    maximumRedirects: ARTICLE_MAX_REDIRECTS,
  });
}

/** The article URL to fetch, or `undefined` when the source is anything other than an article. */
export function articleSourceUrl(source: Pick<StoredSourceAnalysis, "result">): string | undefined {
  const { status, sourceType, canonicalUrl } = source.result;
  if (status !== "resolved" || sourceType !== "article" || typeof canonicalUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || recognizeSource(url.href) || platformMetadataRoute(url.href)
      || NON_ARTICLE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    return undefined;
  }
  return url.href;
}

function declaredCharset(body: Uint8Array, transport: string | undefined): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (transport) return transport;
  const head = new TextDecoder("latin1").decode(body.subarray(0, 1024));
  return /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/iu.exec(head)?.[1]?.toLowerCase();
}

/** Decode exactly as declared. Bytes that do not decode cleanly are never guessed at. */
export function decodeHtml(document: Pick<PublicDocument, "body" | "charset">): string | undefined {
  try {
    return new TextDecoder(declaredCharset(document.body, document.charset) ?? "utf-8", { fatal: true })
      .decode(document.body);
  } catch {
    return undefined;
  }
}

/** Fetch and classify one article. Throws only for failures worth another attempt. */
export async function extractFromUrl(
  url: string,
  fetchDocument: ArticleDocumentFetcher = fetchArticleDocument,
): Promise<ArticleExtraction> {
  let document: PublicDocument;
  try {
    document = await fetchDocument(url);
  } catch (error) {
    if (error instanceof MetadataError && error.code === "metadata_unsupported") {
      return withoutText("unsupported", "not_html", url);
    }
    if (error instanceof MetadataError && error.code === "metadata_too_large") {
      return withoutText("partial", "truncated", url);
    }
    throw error;
  }
  const html = decodeHtml(document);
  if (html === undefined) return withoutText("unsupported", "extraction_failed", document.finalUrl);
  return extractArticle(html, document.finalUrl);
}

/** Claim and process one article-extraction job. No model is called and no text is rewritten. */
export async function processNextArticleExtractionJob({
  store,
  fetchDocument = fetchArticleDocument,
}: ProcessArticleExtractionDependencies): Promise<ArticleExtractionOutcome> {
  const job = await store.claimNextJob("article_extraction");
  if (!job) return { status: "idle" };
  const failed = async (errorCode: string): Promise<ArticleExtractionOutcome> => {
    await store.finishArticleExtractionAttempt(job, null, errorCode);
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode };
  };
  const source = job.sourceAnalysisId
    ? await store.loadSourceAnalysis(job.sourceAnalysisId, job.captureId)
    : undefined;
  if (!source) return failed("source_missing");

  const url = articleSourceUrl(source);
  let extraction: ArticleExtraction;
  if (url === undefined) {
    const canonical = source.result.canonicalUrl;
    extraction = withoutText("unsupported", "not_an_article",
      typeof canonical === "string" && canonical.startsWith("https://") ? canonical : null);
  } else {
    try {
      extraction = await extractFromUrl(url, fetchDocument);
    } catch {
      // Network failures and SSRF refusals alike: the database retries, then records fetch_failed.
      return failed("fetch_failed");
    }
  }

  const finished = await store.finishArticleExtractionAttempt(job, { captureId: job.captureId, ...extraction });
  if (!finished?.extractionId) {
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "lease_lost" };
  }
  return { status: "succeeded", jobId: job.id, captureId: job.captureId,
    extractionId: finished.extractionId, extraction: extraction.status };
}
