import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureRecord,
  SourceResolutionJobStore,
  StoredIntentAnalysis,
} from "../jobs/types";
import { SourceResolutionAnalysisError } from "./protocol";
import type { PublicMetadata } from "./input";
import { METADATA_ERROR_CODES, MetadataError, type MetadataRequest, type MetadataResponse } from "./metadata";
import { fetchPlatformAwareMetadata } from "./platform";
import { processNextSourceResolutionJob } from "./process";
import { SourceResolutionResultSchemaError, type SourceEvidence } from "./result";

const capture: CaptureRecord = {
  id: "capture-10",
  channel: "whatsapp",
  captureKind: "link",
  rawText: "https://www.youtube.com/watch?v=source12345",
  userNote: "Find the full source",
  sourcePlatform: "youtube",
  capturedAt: "2026-09-01T13:00:00Z",
  rawPayload: {},
  assets: [],
};

const intent: StoredIntentAnalysis = {
  id: "intent-10",
  captureId: capture.id,
  inputSnapshot: { captureId: capture.id },
  result: { underlyingSource: { hints: ["The Source Episode"] } },
  confidence: 0.7,
  modelId: "claude-intent",
  promptVersion: "intent-v1",
  pipelineVersion: "intent-pipeline-v1",
};

const directMetadata: PublicMetadata = {
  requestedUrl: "https://www.youtube.com/watch?v=source12345",
  finalUrl: "https://www.youtube.com/watch?v=source12345",
  contentType: "text/html",
  title: "The Source Episode",
  creator: "Ada Example",
  canonicalUrl: "https://redirect.example/not-canonical",
  durationSeconds: 1800,
  transcriptUrl: "https://www.youtube.com/transcript/source12345.vtt",
};

interface FakeStore extends SourceResolutionJobStore {
  records: AnalysisRecordInput[];
  segmentJobs: string[];
}

function fakeStore(): FakeStore {
  let claimed = false;
  const records: AnalysisRecordInput[] = [];
  const segmentJobs: string[] = [];
  return {
    records,
    segmentJobs,
    async claimNextJob(): Promise<CaptureJob | undefined> {
      if (claimed) return undefined;
      claimed = true;
      return {
        id: "source-job-10",
        captureId: capture.id,
        jobType: "source_resolution",
        attempts: 1,
        intentAnalysisId: intent.id,
      };
    },
    async loadCapture() { return structuredClone(capture); },
    async loadIntentAnalysis() { return structuredClone(intent); },
    async finishAttempt(_job, record) {
      if (record) records.push(structuredClone(record));
      if (!record) return { analysisId: null };
      const analysisId = `source-analysis-${records.length}`;
      const transcript = record.result?.transcriptUrl;
      if (record.status === "succeeded" && typeof transcript === "string") {
        segmentJobs.push(`segment-${analysisId}`);
        return { analysisId, segmentJobId: `segment-${analysisId}` };
      }
      return { analysisId };
    },
  };
}

describe("source resolution processing", () => {
  let store: FakeStore;

  beforeEach(() => { store = fakeStore(); });

  it("AC1 stores one immutable direct result with canonical identity, evidence and pipeline provenance", async () => {
    const analyse = vi.fn();
    const beforeCapture = structuredClone(capture);
    const outcome = await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: async () => structuredClone(directMetadata),
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      analysisId: "source-analysis-1",
      modelId: null,
      segmentJobId: "segment-source-analysis-1",
    });
    expect(analyse).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      captureId: capture.id,
      status: "succeeded",
      confidence: 1,
      modelId: null,
      promptVersion: "source-direct-v0.1",
      pipelineVersion: "source-resolution-pipeline-v0.1",
      result: {
        status: "resolved",
        sourceType: "youtube_video",
        title: "The Source Episode",
        creator: "Ada Example",
        canonicalUrl: "https://www.youtube.com/watch?v=source12345",
      },
    });
    expect(store.records[0].result?.evidence).toHaveLength(5);
    expect(await store.loadCapture(capture.id)).toStrictEqual(beforeCapture);
  });

  it("AC2 stores an indirect model result citing only immutable snapshot evidence without changing capture or intent", async () => {
    const indirectCapture = structuredClone(capture);
    indirectCapture.rawText = "https://instagram.com/reel/publicclip";
    indirectCapture.sourcePlatform = "instagram";
    store.loadCapture = async () => structuredClone(indirectCapture);
    const beforeCapture = structuredClone(indirectCapture);
    const beforeIntent = structuredClone(intent);
    const analyse = vi.fn(async (_snapshot, evidence: readonly SourceEvidence[]) => ({
      modelId: "claude-resolution-reported",
      result: {
        status: "resolved" as const,
        sourceType: "podcast_episode" as const,
        title: "The Source Episode",
        creator: "Ada Example",
        canonicalUrl: "https://podcasts.example/episodes/source",
        durationSeconds: null,
        transcriptUrl: null,
        confidence: 0.82,
        evidence: evidence.filter((item) => item.id.startsWith("metadata.0.")).map((item) => item.id),
      },
    }));

    await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: async () => ({
        requestedUrl: "https://instagram.com/reel/publicclip",
        finalUrl: "https://instagram.com/reel/publicclip",
        contentType: "text/html",
        title: "The Source Episode",
        creator: "Ada Example",
        canonicalUrl: "https://podcasts.example/episodes/source",
      }),
    });

    const record = store.records[0];
    const evidenceIds = (record.inputSnapshot.evidence as Array<{ id: string }>).map(({ id }) => id);
    expect((record.result?.evidence as string[]).every((id) => evidenceIds.includes(id))).toBe(true);
    expect(record.modelId).toBe("claude-resolution-reported");
    expect(await store.loadCapture(capture.id)).toStrictEqual(beforeCapture);
    expect(await store.loadIntentAnalysis(intent.id, capture.id)).toStrictEqual(beforeIntent);
  });

  it("AC3 stores explicit unresolved null identity when evidence is insufficient", async () => {
    const analyse = vi.fn();
    await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: async () => { throw new MetadataError("metadata_unsupported"); },
    });

    expect(analyse).not.toHaveBeenCalled();
    expect(store.records[0]).toMatchObject({
      status: "succeeded",
      confidence: 0,
      result: {
        status: "unresolved",
        sourceType: null,
        title: null,
        creator: null,
        canonicalUrl: null,
        transcriptUrl: null,
      },
    });
  });

  it("AC4 never sends rejected unsafe metadata content to the model", async () => {
    const analyse = vi.fn();
    await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: async () => { throw new MetadataError("unsafe_url"); },
    });
    expect(analyse).not.toHaveBeenCalled();
    expect(store.records[0].inputSnapshot.publicMetadata).toStrictEqual([]);
    expect(store.records[0].result).toMatchObject({ status: "unresolved" });
  });

  it.each([
    ["transient metadata failure", new MetadataError("metadata_unavailable"), "metadata_unavailable"],
    ["Anthropic provider failure", new SourceResolutionAnalysisError("private upstream response"), "provider_response_invalid"],
    ["schema failure", new SourceResolutionResultSchemaError("invented identity"), "result_schema_invalid"],
    ["Anthropic authentication failure", Object.assign(new Error("private auth detail"), { status: 401 }), "provider_unavailable"],
    ["Anthropic rate limit", Object.assign(new Error("private rate detail"), { status: 429 }), "provider_unavailable"],
    ["Anthropic server failure", Object.assign(new Error("private server detail"), { status: 503 }), "provider_unavailable"],
    ["Anthropic network failure", new Error("private network detail"), "provider_unavailable"],
  ])("later-0013 AC4/AC5 retries a %s with only a safe failure code and preserves successful analyses", async (_label, error, code) => {
    const previous: AnalysisRecordInput = {
      captureId: capture.id,
      status: "succeeded",
      inputSnapshot: {},
      result: { status: "resolved" },
      confidence: 0.9,
      modelId: null,
      promptVersion: "source-direct-v0.1",
      pipelineVersion: "source-resolution-pipeline-v0.1",
      errorCode: null,
    };
    store.records.push(structuredClone(previous));
    const indirectCapture = structuredClone(capture);
    indirectCapture.rawText = "https://instagram.com/reel/publicclip";
    store.loadCapture = async () => indirectCapture;

    const outcome = await processNextSourceResolutionJob({
      store,
      analyse: async () => { throw error; },
      fetchMetadata: async () => {
        if (error instanceof MetadataError) throw error;
        return {
          requestedUrl: "https://instagram.com/reel/publicclip",
          finalUrl: "https://instagram.com/reel/publicclip",
          contentType: "text/html",
          title: "The Source Episode",
          creator: "Ada Example",
          canonicalUrl: "https://podcasts.example/episodes/source",
        };
      },
    });

    expect(outcome).toMatchObject({ status: "failed", errorCode: code });
    expect(store.records[0]).toStrictEqual(previous);
    expect(store.records[1]).toMatchObject({ status: "failed", result: null, errorCode: code });
    expect(JSON.stringify(store.records[1])).not.toContain("private");
  });

  it("AC6 creates exactly one segment job for a supported transcript and none without one", async () => {
    await processNextSourceResolutionJob({
      store,
      analyse: vi.fn(),
      fetchMetadata: async () => structuredClone(directMetadata),
    });
    expect(store.segmentJobs).toStrictEqual(["segment-source-analysis-1"]);

    const withoutTranscript = fakeStore();
    await processNextSourceResolutionJob({
      store: withoutTranscript,
      analyse: vi.fn(),
      fetchMetadata: async () => ({ ...directMetadata, transcriptUrl: undefined }),
    });
    expect(withoutTranscript.segmentJobs).toStrictEqual([]);
  });

  it("AC7 persists source type and confidence separately from the selected intent run", async () => {
    await processNextSourceResolutionJob({
      store,
      analyse: vi.fn(),
      fetchMetadata: async () => structuredClone(directMetadata),
    });
    expect(intent.confidence).toBe(0.7);
    expect(store.records[0].confidence).toBe(1);
    expect(store.records[0].inputSnapshot.intentAnalysis).toMatchObject({ id: intent.id, confidence: 0.7 });
  });
});

describe("later-0016 platform-aware source resolution", () => {
  const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

  function platformResponse(
    body: string,
    contentType = "application/json; charset=utf-8",
    status = 200,
  ): MetadataResponse {
    return {
      status,
      headers: { "content-type": contentType },
      body: new TextEncoder().encode(body),
    };
  }

  /** Drive the real platform router, with only the socket and DNS boundaries replaced. */
  function platformFetcher(request: MetadataRequest) {
    return (url: string) => fetchPlatformAwareMetadata(url, { resolveHostname: publicResolver, request });
  }

  function notices(record: AnalysisRecordInput): string[] {
    const evidence = record.inputSnapshot.evidence as Array<{ kind: string; value: string }>;
    return evidence.filter(({ kind }) => kind === "resolution_notice").map(({ value }) => value);
  }

  let store: FakeStore;

  beforeEach(() => { store = fakeStore(); });

  it("AC1/AC2 resolves a captured YouTube link deterministically from oEmbed alone", async () => {
    const analyse = vi.fn();
    const request = vi.fn<MetadataRequest>(async () => platformResponse(JSON.stringify({
      title: "The Source Episode",
      author_name: "Ada Example",
      html: "<iframe src=\"https://www.youtube.com/embed/source12345\"></iframe>",
      thumbnail_url: "https://i.ytimg.com/vi/source12345/hq.jpg",
    })));

    const outcome = await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: platformFetcher(request),
    });

    expect(request.mock.calls.map(([url]) => url.pathname)).toStrictEqual(["/oembed"]);
    expect(analyse).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "succeeded", modelId: null });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      status: "succeeded",
      confidence: 1,
      modelId: null,
      promptVersion: "source-direct-v0.1",
      result: {
        status: "resolved",
        sourceType: "youtube_video",
        title: "The Source Episode",
        creator: "Ada Example",
        canonicalUrl: "https://www.youtube.com/watch?v=source12345",
        durationSeconds: null,
        transcriptUrl: null,
      },
    });
    // No transcript is claimed, so no segment job is created and no media is downloaded.
    expect(store.segmentJobs).toStrictEqual([]);
    expect(JSON.stringify(store.records[0].result)).not.toContain("iframe");
    expect(JSON.stringify(store.records[0].result)).not.toContain("ytimg");
  });

  it("AC3/AC7 records only an allow-listed notice and an unresolved result for a rejected oEmbed response", async () => {
    const analyse = vi.fn();
    const request = vi.fn<MetadataRequest>(async () => platformResponse(
      JSON.stringify({ error: "forbidden for key sk-private-token" }),
      "application/json",
      403,
    ));

    const outcome = await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: platformFetcher(request),
    });

    expect(analyse).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(store.records[0]).toMatchObject({
      status: "succeeded",
      errorCode: null,
      result: { status: "unresolved", sourceType: null, title: null, canonicalUrl: null },
    });
    expect(store.records[0].inputSnapshot.publicMetadata).toStrictEqual([]);

    const recorded = notices(store.records[0]);
    expect(recorded).toHaveLength(1);
    expect(METADATA_ERROR_CODES).toContain(recorded[0]);
    expect(recorded[0]).not.toBe("metadata_unavailable");
    const observable = JSON.stringify({ result: store.records[0].result, notices: recorded });
    for (const secret of ["source12345", "sk-private-token", "forbidden", "youtube"]) {
      expect(observable).not.toContain(secret);
    }
  });

  it("AC4 retries a YouTube metadata endpoint outage with the safe category and preserves earlier analyses", async () => {
    const previous: AnalysisRecordInput = {
      captureId: capture.id,
      status: "succeeded",
      inputSnapshot: {},
      result: { status: "resolved" },
      confidence: 0.9,
      modelId: null,
      promptVersion: "source-direct-v0.1",
      pipelineVersion: "source-resolution-pipeline-v0.1",
      errorCode: null,
    };
    store.records.push(structuredClone(previous));

    const outcome = await processNextSourceResolutionJob({
      store,
      analyse: vi.fn(),
      fetchMetadata: platformFetcher(vi.fn<MetadataRequest>(
        async () => platformResponse("upstream is down", "text/plain", 503),
      )),
    });

    expect(outcome).toMatchObject({ status: "failed", errorCode: "metadata_unavailable" });
    expect(store.records[0]).toStrictEqual(previous);
    expect(store.records[1]).toMatchObject({ status: "failed", result: null, errorCode: "metadata_unavailable" });
    expect(JSON.stringify(store.records[1])).not.toContain("upstream is down");
  });

  it("AC5 completes an Instagram capture as unresolved without requesting the application page", async () => {
    const instagramCapture = structuredClone(capture);
    instagramCapture.rawText = "https://www.instagram.com/reel/AbC-d_123/?igsh=trackingvalue";
    instagramCapture.sourcePlatform = "instagram";
    store.loadCapture = async () => structuredClone(instagramCapture);
    const analyse = vi.fn();
    const request = vi.fn<MetadataRequest>();

    const outcome = await processNextSourceResolutionJob({
      store,
      analyse,
      fetchMetadata: platformFetcher(request),
    });

    // A permanent verdict, not a third of a retry budget: the job succeeds and never re-runs.
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(request).not.toHaveBeenCalled();
    expect(analyse).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      status: "succeeded",
      errorCode: null,
      confidence: 0,
      modelId: null,
      result: { status: "unresolved", sourceType: null, title: null, creator: null, canonicalUrl: null },
    });
    expect(notices(store.records[0])).toStrictEqual(["metadata_unsupported_platform"]);
    expect(store.records[0].inputSnapshot.publicMetadata).toStrictEqual([]);
  });

  it("AC6 leaves an ordinary public link on the unchanged generic metadata path", async () => {
    const articleCapture = structuredClone(capture);
    articleCapture.rawText = "https://example.com/articles/the-source";
    articleCapture.sourcePlatform = "web";
    store.loadCapture = async () => structuredClone(articleCapture);
    const request = vi.fn<MetadataRequest>(async () => platformResponse(
      '<meta property="og:title" content="The Source Episode"><meta name="author" content="Ada Example">',
      "text/html; charset=utf-8",
    ));
    const analyse = vi.fn(async (_snapshot, evidence: readonly SourceEvidence[]) => ({
      modelId: "claude-resolution-reported",
      result: {
        status: "unresolved" as const,
        sourceType: null,
        title: null,
        creator: null,
        canonicalUrl: null,
        durationSeconds: null,
        transcriptUrl: null,
        confidence: 0,
        evidence: [evidence[0].id],
      },
    }));

    await processNextSourceResolutionJob({ store, analyse, fetchMetadata: platformFetcher(request) });

    expect(request.mock.calls.map(([url]) => url.href))
      .toStrictEqual(["https://example.com/articles/the-source"]);
    expect(store.records[0].inputSnapshot.publicMetadata).toStrictEqual([{
      requestedUrl: "https://example.com/articles/the-source",
      finalUrl: "https://example.com/articles/the-source",
      contentType: "text/html",
      title: "The Source Episode",
      creator: "Ada Example",
    }]);
    expect(analyse).toHaveBeenCalledTimes(1);
  });
});
