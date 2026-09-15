import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureRecord,
  SegmentResolutionJobStore,
  StoredIntentAnalysis,
  StoredSourceAnalysis,
} from "../jobs/types";
import { MetadataError } from "./metadata";
import type { SegmentMaterial } from "./segment-material";
import { processNextSegmentResolutionJob } from "./segment-process";
import { SegmentResolutionResultSchemaError } from "./segment-result";

const capture: CaptureRecord = {
  id: "capture-11", channel: "whatsapp", captureKind: "link", rawText: "A saved clip",
  userNote: "The part about durable queues", sourcePlatform: "youtube",
  capturedAt: "2026-09-01T13:00:00Z", rawPayload: {}, assets: [],
};

const source: StoredSourceAnalysis = {
  id: "source-11", captureId: capture.id,
  inputSnapshot: { intentAnalysis: { id: "intent-11", result: {
    interest: { summary: "durable queues", confidence: 0.9 },
  } } },
  result: { status: "resolved", sourceType: "youtube_video", title: "Queues",
    creator: "Ada", canonicalUrl: "https://example.com/watch", durationSeconds: 120,
    transcriptUrl: "https://example.com/transcript.vtt", confidence: 0.9, evidence: ["metadata.0"] },
  confidence: 0.9, modelId: null, promptVersion: "source-direct-v0.1",
  pipelineVersion: "source-resolution-pipeline-v0.1",
};

const timedMaterial: SegmentMaterial = {
  requestedUrl: "https://example.com/transcript.vtt",
  finalUrl: "https://cdn.example.com/transcript.vtt",
  contentType: "text/vtt", sha256: "a".repeat(64), byteLength: 80,
  representation: "timed", durationSeconds: 120,
  content: "Opening Durable queues survive retries Closing",
  evidence: [
    { id: "cue.0", kind: "timed", startSeconds: 10, endSeconds: 14, text: "Opening" },
    { id: "cue.1", kind: "timed", startSeconds: 14, endSeconds: 22, text: "Durable queues survive retries" },
  ],
};

const textMaterial: SegmentMaterial = {
  requestedUrl: "https://example.com/article.txt", finalUrl: "https://example.com/article.txt",
  contentType: "text/plain", sha256: "b".repeat(64), byteLength: 42,
  representation: "text", durationSeconds: null,
  content: "Opening\nDurable queues survive retries\nClosing",
  evidence: [{ id: "text.0", kind: "text", start: 0, end: 45,
    text: "Opening\nDurable queues survive retries\nClosing" }],
};

interface FakeStore extends SegmentResolutionJobStore {
  records: AnalysisRecordInput[];
  finish: ReturnType<typeof vi.fn>;
}

function fakeStore(sourceRecord: StoredSourceAnalysis = source): FakeStore {
  let claimed = false;
  const records: AnalysisRecordInput[] = [];
  const finish = vi.fn(async (_job: CaptureJob, record: AnalysisRecordInput | null) => {
    if (record) records.push(structuredClone(record));
    return { analysisId: record ? `segment-${records.length}` : null };
  });
  return {
    records,
    finish,
    async claimNextJob() {
      if (claimed) return undefined;
      claimed = true;
      return { id: "segment-job-11", captureId: capture.id, jobType: "segment_resolution",
        attempts: 1, sourceAnalysisId: sourceRecord.id };
    },
    async loadCapture() { return structuredClone(capture); },
    async loadIntentAnalysis(): Promise<StoredIntentAnalysis | undefined> { return undefined; },
    async loadSourceAnalysis() { return structuredClone(sourceRecord); },
    finishAttempt: finish,
  };
}

describe("segment resolution processing", () => {
  let store: FakeStore;
  beforeEach(() => { store = fakeStore(); });

  it("AC1 stores one timed result with in-range locators, cited transcript evidence and complete provenance", async () => {
    const analyse = vi.fn(async () => ({ modelId: "claude-segment-reported", result: {
      status: "resolved" as const, representation: "timed" as const, startSeconds: 14, endSeconds: 22,
      sectionStart: null, sectionEnd: null, excerpt: "Durable queues survive retries", label: null,
      confidence: 0.92, evidence: ["cue.1"],
    } }));
    const outcome = await processNextSegmentResolutionJob({ store, analyse,
      fetchMaterial: async () => structuredClone(timedMaterial) });

    expect(outcome).toMatchObject({ status: "succeeded", analysisId: "segment-1",
      modelId: "claude-segment-reported" });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      status: "succeeded", confidence: 0.92, modelId: "claude-segment-reported",
      promptVersion: "segment-resolution-v0.1", pipelineVersion: "segment-resolution-pipeline-v0.1",
      inputSnapshot: {
        sourceAnalysis: { id: source.id },
        sourceMaterial: { finalUrl: timedMaterial.finalUrl, sha256: timedMaterial.sha256 },
      },
      result: { representation: "timed", startSeconds: 14, endSeconds: 22,
        excerpt: "Durable queues survive retries", evidence: ["cue.1"] },
    });
  });

  it("AC2 stores valid text boundaries and never fabricates timestamps", async () => {
    const textSource = structuredClone(source);
    textSource.result.durationSeconds = null;
    textSource.result.transcriptUrl = textMaterial.requestedUrl;
    store = fakeStore(textSource);
    const start = textMaterial.content.indexOf("Durable");
    await processNextSegmentResolutionJob({
      store,
      fetchMaterial: async () => structuredClone(textMaterial),
      analyse: async () => ({ modelId: "claude-segment", result: {
        status: "resolved", representation: "text", startSeconds: null, endSeconds: null,
        sectionStart: start, sectionEnd: start + "Durable queues survive retries".length,
        excerpt: "Durable queues survive retries", label: null, confidence: 0.8, evidence: ["text.0"],
      } }),
    });
    expect(store.records[0].result).toMatchObject({ representation: "text", startSeconds: null,
      endSeconds: null, sectionStart: start, excerpt: "Durable queues survive retries" });
  });

  it.each([
    ["no transcript", "absent"],
    ["unsupported representation", "unsupported"],
    ["insufficient evidence", "insufficient"],
  ])("AC3 records explicit unresolved output with no invented locator for %s", async (_label, mode) => {
    const analyse = vi.fn(async () => ({ modelId: "claude-segment", result: {
      status: "unresolved" as const, representation: null, startSeconds: null, endSeconds: null,
      sectionStart: null, sectionEnd: null, excerpt: null, label: null,
      confidence: 0.1, evidence: ["cue.0"],
    } }));
    if (mode === "absent") {
      const absent = structuredClone(source);
      absent.result.transcriptUrl = null;
      store = fakeStore(absent);
    }
    const outcome = await processNextSegmentResolutionJob({ store, analyse,
      fetchMaterial: async () => {
        if (mode === "unsupported") throw new MetadataError("metadata_unsupported");
        return structuredClone(timedMaterial);
      } });
    expect(outcome.status).toBe("succeeded");
    expect(store.records[0].result).toMatchObject({ status: "unresolved", representation: null,
      startSeconds: null, endSeconds: null, sectionStart: null, sectionEnd: null, excerpt: null });
  });

  it("AC4 stores no successful result when model validation rejects fabricated locators", async () => {
    const previous = structuredClone(source);
    const outcome = await processNextSegmentResolutionJob({ store,
      fetchMaterial: async () => structuredClone(timedMaterial),
      analyse: async () => { throw new SegmentResolutionResultSchemaError("timestamps invalid"); } });
    expect(outcome).toMatchObject({ status: "failed", errorCode: "result_schema_invalid" });
    expect(store.records[0]).toMatchObject({ status: "failed", result: null,
      errorCode: "result_schema_invalid" });
    expect(source).toStrictEqual(previous);
  });

  it.each(["unsafe_url", "unsafe_redirect", "metadata_too_large"] as const)(
    "AC5 turns rejected %s retrieval into unresolved without model use or persisted content",
    async (code) => {
      const analyse = vi.fn();
      await processNextSegmentResolutionJob({ store, analyse,
        fetchMaterial: async () => { throw new MetadataError(code); } });
      expect(analyse).not.toHaveBeenCalled();
      expect(store.records[0].inputSnapshot.sourceMaterial).toBeNull();
      expect(JSON.stringify(store.records[0])).not.toContain("private transcript content");
      expect(store.records[0].result).toMatchObject({ status: "unresolved" });
    },
  );

  it("AC6 a retry/overlap can publish at most one segment result while prior stages stay unchanged", async () => {
    const beforeSource = structuredClone(source);
    const analyse = vi.fn(async () => ({ modelId: "claude-segment", result: {
      status: "resolved" as const, representation: "timed" as const, startSeconds: 14, endSeconds: 22,
      sectionStart: null, sectionEnd: null, excerpt: "Durable queues survive retries", label: null,
      confidence: 0.8, evidence: ["cue.1"],
    } }));
    const dependencies = { store, analyse, fetchMaterial: async () => structuredClone(timedMaterial) };
    const [first, replay] = await Promise.all([
      processNextSegmentResolutionJob(dependencies),
      processNextSegmentResolutionJob(dependencies),
    ]);
    expect([first.status, replay.status].sort()).toStrictEqual(["idle", "succeeded"]);
    expect(store.records).toHaveLength(1);
    expect(store.finish).toHaveBeenCalledTimes(1);
    expect(source).toStrictEqual(beforeSource);
  });

  it("AC7 preserves independent source and segment status/confidence values", async () => {
    await processNextSegmentResolutionJob({ store, fetchMaterial: async () => structuredClone(timedMaterial),
      analyse: async () => ({ modelId: "claude-segment", result: {
        status: "unresolved", representation: null, startSeconds: null, endSeconds: null,
        sectionStart: null, sectionEnd: null, excerpt: null, label: null,
        confidence: 0.2, evidence: ["cue.0"],
      } }) });
    expect(source).toMatchObject({ confidence: 0.9, result: { status: "resolved" } });
    expect(store.records[0]).toMatchObject({ confidence: 0.2, result: { status: "unresolved" } });
  });
});
