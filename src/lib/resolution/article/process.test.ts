import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  ArticleExtractionJobStore,
  ArticleExtractionRecordInput,
  CaptureJob,
  JsonValue,
  StoredSourceAnalysis,
} from "../../jobs/types";
import type { MetadataRequest, MetadataResponse, ResolvedAddress } from "../metadata";
import { articleSourceUrl, fetchArticleDocument, processNextArticleExtractionJob } from "./process";

const fullArticle = readFileSync(new URL("./fixtures/full-article.html", import.meta.url), "utf8");

function sourceWith(result: Record<string, JsonValue>): StoredSourceAnalysis {
  return {
    id: "source-24", captureId: "capture-24", inputSnapshot: {}, result, confidence: 0.9,
    modelId: null, promptVersion: "source-direct-v0.1", pipelineVersion: "source-resolution-pipeline-v0.1",
  };
}

function resolved(sourceType: string, canonicalUrl: string): StoredSourceAnalysis {
  return sourceWith({ status: "resolved", sourceType, title: "A title", creator: "Ada", canonicalUrl,
    durationSeconds: null, transcriptUrl: null, confidence: 0.9, evidence: ["metadata.0"] });
}

const article = resolved("article", "https://example.com/essay");

interface FakeStore extends ArticleExtractionJobStore {
  finishes: Array<{ job: CaptureJob; record: ArticleExtractionRecordInput | null; errorCode?: string }>;
}

/** A store that hands out the same job for `attempts` successive claims, like durable retries. */
function fakeStore(source: StoredSourceAnalysis | null = article, attempts = 1): FakeStore {
  let claims = 0;
  const finishes: FakeStore["finishes"] = [];
  return {
    finishes,
    async claimNextJob(jobType) {
      if (jobType !== "article_extraction" || claims >= attempts) return undefined;
      claims += 1;
      return { id: "article-job-24", captureId: "capture-24", jobType, attempts: claims,
        sourceAnalysisId: "source-24" };
    },
    async loadCapture() { return undefined; },
    async loadIntentAnalysis() { return undefined; },
    async loadSourceAnalysis() { return source ? structuredClone(source) : undefined; },
    async finishAttempt() { throw new Error("article jobs never publish capture analyses"); },
    async finishArticleExtractionAttempt(job, record, errorCode) {
      finishes.push({ job, record: structuredClone(record), ...(errorCode ? { errorCode } : {}) });
      return { extractionId: record ? "extraction-24" : null };
    },
  };
}

function html(body: string, status = 200, headers: Record<string, string> = {}): MetadataResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: new TextEncoder().encode(body) };
}

describe("article extraction processing", () => {
  it("is idle when no article job is pending", async () => {
    expect(await processNextArticleExtractionJob({ store: fakeStore(article, 0) })).toEqual({ status: "idle" });
  });

  it.each([
    ["a YouTube video", resolved("youtube_video", "https://www.youtube.com/watch?v=abcdefgh")],
    ["a Spotify episode", resolved("spotify_episode", "https://open.spotify.com/episode/abcdefghij")],
    ["a podcast episode", resolved("podcast_episode", "https://example.com/podcast/1")],
    ["an other source", resolved("other", "https://example.com/thing")],
    ["an unresolved source", sourceWith({ status: "unresolved", sourceType: null, title: null, creator: null,
      canonicalUrl: null, durationSeconds: null, transcriptUrl: null, confidence: 0.1, evidence: ["capture.0"] })],
    ["an 'article' on YouTube", resolved("article", "https://www.youtube.com/watch?v=abcdefgh")],
    ["an 'article' on Instagram", resolved("article", "https://www.instagram.com/p/ABCDE12345/")],
    ["an 'article' on X", resolved("article", "https://x.com/someone/status/1")],
    ["an 'article' on TikTok", resolved("article", "https://www.tiktok.com/@someone/video/1")],
    ["an 'article' on Apple Podcasts", resolved("article", "https://podcasts.apple.com/gb/podcast/x/id1")],
    ["an 'article' over plain HTTP", resolved("article", "http://example.com/essay")],
  ])("%s is never fetched and is recorded unsupported/not_an_article", async (_label, source) => {
    const store = fakeStore(source);
    const fetchDocument = vi.fn();
    const outcome = await processNextArticleExtractionJob({ store, fetchDocument });

    expect(fetchDocument).not.toHaveBeenCalled();
    expect(articleSourceUrl(source)).toBeUndefined();
    expect(store.finishes).toHaveLength(1);
    expect(store.finishes[0].record).toMatchObject({ status: "unsupported", reason: "not_an_article",
      paragraphs: null, captureId: "capture-24" });
    expect(outcome).toMatchObject({ status: "succeeded", extraction: "unsupported" });
  });

  it("publishes a full extraction of a public article through the shared SSRF-safe fetcher", async () => {
    const store = fakeStore();
    const request = vi.fn<MetadataRequest>(async () => html(fullArticle));
    const outcome = await processNextArticleExtractionJob({ store, fetchDocument: (url) => fetchArticleDocument(url, {
      resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }], request }) });

    expect(outcome).toStrictEqual({ status: "succeeded", jobId: "article-job-24", captureId: "capture-24",
      extractionId: "extraction-24", extraction: "full" });
    expect(store.finishes[0].record).toMatchObject({ status: "full", reason: null,
      sourceUrl: "https://example.com/essay", extractorVersion: "article-extraction-v1" });
    expect(store.finishes[0].record!.paragraphs!.length).toBeGreaterThan(1);
    expect(request.mock.calls[0][3]).toBe(10_000);
  });

  // The same destinations the source-resolution SSRF suite refuses (see ../metadata.test.ts).
  const privateTargets: Array<[string, string, (hostname: string) => Promise<readonly ResolvedAddress[]>]> = [
    ["a loopback literal", "https://127.0.0.1/essay", async () => [{ address: "127.0.0.1", family: 4 }]],
    ["an IPv6 loopback literal", "https://[::1]/essay", async () => [{ address: "::1", family: 6 }]],
    ["localhost", "https://localhost/essay", async () => [{ address: "127.0.0.1", family: 4 }]],
    ["DNS to the metadata service", "https://example.com/essay", async () => [{ address: "169.254.169.254", family: 4 }]],
    ["DNS to a private range", "https://example.com/essay", async () => [{ address: "10.0.0.1", family: 4 }]],
    ["DNS to a mapped loopback", "https://example.com/essay", async () => [{ address: "::ffff:127.0.0.1", family: 6 }]],
  ];

  it.each(privateTargets)("%s is never connected to and ends failed/fetch_failed after retries", async (_label, url, resolveHostname) => {
    const store = fakeStore(resolved("article", url), 3);
    const request = vi.fn<MetadataRequest>(async () => html(fullArticle));
    const fetchDocument = (target: string) => fetchArticleDocument(target, { resolveHostname, request });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await processNextArticleExtractionJob({ store, fetchDocument }))
        .toMatchObject({ status: "failed", errorCode: "fetch_failed" });
    }

    expect(request).not.toHaveBeenCalled();
    expect(store.finishes.map(({ job, record, errorCode }) => [job.attempts, record, errorCode]))
      .toStrictEqual([[1, null, "fetch_failed"], [2, null, "fetch_failed"], [3, null, "fetch_failed"]]);
  });

  it("a redirect to a private address is refused before a second connection", async () => {
    const store = fakeStore(article, 3);
    const request = vi.fn<MetadataRequest>(async () => html("", 302, { location: "https://internal.example/admin" }));
    const resolveHostname = vi.fn(async (hostname: string) => [{
      address: hostname === "internal.example" ? "169.254.169.254" : "93.184.216.34", family: 4 as const }]);
    const fetchDocument = (target: string) => fetchArticleDocument(target, { resolveHostname, request });

    for (let attempt = 1; attempt <= 3; attempt += 1) await processNextArticleExtractionJob({ store, fetchDocument });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([url]) => url.hostname === "example.com")).toBe(true);
    expect(store.finishes.every(({ record, errorCode }) => record === null && errorCode === "fetch_failed")).toBe(true);
  });

  it("a network failure is retried rather than recorded as a verdict", async () => {
    const store = fakeStore();
    const outcome = await processNextArticleExtractionJob({ store, fetchDocument: async () => {
      throw new Error("socket hang up");
    } });
    expect(outcome).toMatchObject({ status: "failed", errorCode: "fetch_failed" });
    expect(store.finishes).toStrictEqual([{ job: expect.objectContaining({ attempts: 1 }), record: null,
      errorCode: "fetch_failed" }]);
  });

  it("a missing source analysis fails the job without fetching", async () => {
    const store = fakeStore(null);
    const fetchDocument = vi.fn();
    expect(await processNextArticleExtractionJob({ store, fetchDocument }))
      .toMatchObject({ status: "failed", errorCode: "source_missing" });
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("does not report success after losing the lease", async () => {
    const store = fakeStore();
    store.finishArticleExtractionAttempt = async () => undefined;
    expect(await processNextArticleExtractionJob({ store, fetchDocument: async () => ({
      requestedUrl: "https://example.com/essay", finalUrl: "https://example.com/essay",
      contentType: "text/html", body: new TextEncoder().encode(fullArticle) }) }))
      .toMatchObject({ status: "failed", errorCode: "lease_lost" });
  });
});
