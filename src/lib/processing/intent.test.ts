import { beforeEach, describe, expect, it, vi } from "vitest";

import { processNextIntentJob } from "./intent";
import { buildIntentInputSnapshot } from "./intent-input";
import { IntentResultSchemaError, type IntentResult } from "./intent-result";
import { IntentAnalysisError } from "./errors";
import { PIPELINE_VERSION, PROMPT_VERSION } from "./prompt";
import type { IntentAnalyser } from "./anthropic";
import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureJobStore,
  CaptureJobType,
  CaptureRecord,
} from "../jobs/types";

const capture: CaptureRecord = {
  id: "capture-9",
  channel: "whatsapp",
  captureKind: "link",
  rawText: "https://www.youtube.com/watch?v=abc",
  userNote: "the bit about sourdough starters",
  sourcePlatform: "youtube",
  capturedAt: "2026-09-01T13:00:00.000Z",
  rawPayload: { NumSegments: "1" },
  assets: [],
};

function intentResult(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    contentType: "video",
    interest: { summary: "Wants the sourdough starter segment", confidence: 0.8 },
    classification: { value: "reference", confidence: 0.6 },
    underlyingSource: { hints: ["youtube video"], confidence: 0.9 },
    resolutionRequired: false,
    evidence: [{ field: "userNote", observation: "names one segment", weight: "primary" }],
    ...overrides,
  };
}

interface FakeStore extends CaptureJobStore {
  analyses: AnalysisRecordInput[];
  jobs: Array<{ id: string; captureId: string; jobType: CaptureJobType; status: string }>;
  releases: Array<{ jobId: string; message: string }>;
  completed: string[];
}

function createFakeStore(options: { capture?: CaptureRecord; pendingJobs?: number } = {}): FakeStore {
  const stored = options.capture === undefined ? capture : options.capture;
  const analyses: AnalysisRecordInput[] = [];
  const jobs: FakeStore["jobs"] = [];
  const releases: FakeStore["releases"] = [];
  const completed: string[] = [];
  let claims = 0;
  let enqueued = 0;

  for (let index = 0; index < (options.pendingJobs ?? 0); index += 1) {
    jobs.push({
      id: `existing-resolution-${index}`,
      captureId: stored.id,
      jobType: "source_resolution",
      status: "pending",
    });
  }

  return {
    analyses,
    jobs,
    releases,
    completed,
    async claimNextJob(jobType: CaptureJobType): Promise<CaptureJob | undefined> {
      claims += 1;
      return claims > 1
        ? undefined
        : { id: "job-1", captureId: stored.id, jobType, attempts: 1 };
    },
    async loadCapture(captureId: string): Promise<CaptureRecord | undefined> {
      return captureId === stored.id ? stored : undefined;
    },
    async appendAnalysis(record: AnalysisRecordInput): Promise<string> {
      analyses.push(record);
      return `analysis-${analyses.length}`;
    },
    async completeJob(jobId: string): Promise<void> {
      completed.push(jobId);
    },
    async releaseJob(jobId: string, message: string): Promise<void> {
      releases.push({ jobId, message });
    },
    async countPendingJobs(captureId: string, jobType: CaptureJobType): Promise<number> {
      return jobs.filter(
        (job) => job.captureId === captureId && job.jobType === jobType && job.status === "pending",
      ).length;
    },
    async enqueueJob(captureId: string, jobType: CaptureJobType): Promise<string> {
      enqueued += 1;
      const id = `resolution-${enqueued}`;
      jobs.push({ id, captureId, jobType, status: "pending" });
      return id;
    },
  };
}

function analyserReturning(result: IntentResult, modelId = "claude-haiku-4-5"): IntentAnalyser {
  return async () => ({ result, modelId });
}

describe("processNextIntentJob", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore();
  });

  it("AC1 stores exactly one immutable analysis with its snapshot, model and versions", async () => {
    const outcome = await processNextIntentJob({
      store,
      analyse: analyserReturning(intentResult(), "claude-haiku-4-5"),
    });

    expect(outcome).toStrictEqual({
      status: "succeeded",
      jobId: "job-1",
      captureId: "capture-9",
      analysisId: "analysis-1",
      modelId: "claude-haiku-4-5",
    });
    expect(store.analyses).toHaveLength(1);
    expect(store.analyses[0]).toStrictEqual({
      captureId: "capture-9",
      status: "succeeded",
      inputSnapshot: buildIntentInputSnapshot(capture),
      result: JSON.parse(JSON.stringify(intentResult())),
      confidence: 0.6,
      modelId: "claude-haiku-4-5",
      promptVersion: PROMPT_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      errorCode: null,
    });
    expect(store.completed).toStrictEqual(["job-1"]);
  });

  it("AC1 does nothing and claims nothing further when no job is pending", async () => {
    const idleStore = createFakeStore();
    idleStore.claimNextJob = async () => undefined;
    const analyse = vi.fn<IntentAnalyser>();

    expect(await processNextIntentJob({ store: idleStore, analyse })).toStrictEqual({
      status: "idle",
    });
    expect(analyse).not.toHaveBeenCalled();
    expect(idleStore.analyses).toStrictEqual([]);
  });

  it.each([
    ["a schema-invalid model response", new IntentResultSchemaError("contentType must be one of"), "result_schema_invalid"],
    ["an unusable provider response", new IntentAnalysisError("Anthropic declined"), "provider_response_invalid"],
    ["an Anthropic outage", Object.assign(new Error("upstream down"), { status: 503 }), "provider_unavailable"],
  ])(
    "AC3 records %s as a failed attempt and leaves the job retryable",
    async (_label, failure, expectedCode) => {
      const before = structuredClone(capture);

      const outcome = await processNextIntentJob({
        store,
        analyse: async () => {
          throw failure;
        },
      });

      expect(outcome).toStrictEqual({
        status: "failed",
        jobId: "job-1",
        captureId: "capture-9",
        errorCode: expectedCode,
      });
      expect(store.analyses).toHaveLength(1);
      expect(store.analyses[0].status).toBe("failed");
      expect(store.analyses[0].errorCode).toBe(expectedCode);
      expect(store.analyses[0].result).toBeNull();
      expect(store.analyses[0].confidence).toBeNull();
      expect(store.analyses[0].modelId).toBeNull();
      expect(store.completed).toStrictEqual([]);
      expect(store.releases).toStrictEqual([
        { jobId: "job-1", message: expect.stringContaining(expectedCode) },
      ]);
      expect(await store.loadCapture("capture-9")).toStrictEqual(before);
    },
  );

  it("AC3 records the failure reason without echoing provider or capture text", async () => {
    await processNextIntentJob({
      store,
      analyse: async () => {
        throw new IntentAnalysisError("model said: the bit about sourdough starters");
      },
    });

    expect(store.releases[0].message).toBe("provider_response_invalid (IntentAnalysisError)");
    expect(store.releases[0].message).not.toContain("sourdough");
  });

  it("AC3 leaves a prior successful analysis untouched when a later run fails", async () => {
    const persistentStore = createFakeStore();
    persistentStore.claimNextJob = async (jobType) => ({
      id: "job-1",
      captureId: capture.id,
      jobType,
      attempts: 1,
    });

    await processNextIntentJob({ store: persistentStore, analyse: analyserReturning(intentResult()) });
    const firstRun = structuredClone(persistentStore.analyses[0]);

    await processNextIntentJob({
      store: persistentStore,
      analyse: async () => {
        throw new IntentAnalysisError("declined");
      },
    });

    expect(persistentStore.analyses).toHaveLength(2);
    expect(persistentStore.analyses[0]).toStrictEqual(firstRun);
    expect(persistentStore.analyses[1].status).toBe("failed");
  });

  it("AC4 appends a distinct record on a second successful run and never edits the first", async () => {
    const persistentStore = createFakeStore();
    persistentStore.claimNextJob = async (jobType) => ({
      id: "job-1",
      captureId: capture.id,
      jobType,
      attempts: 1,
    });

    const first = await processNextIntentJob({
      store: persistentStore,
      analyse: analyserReturning(intentResult(), "claude-haiku-4-5"),
    });
    const firstRun = structuredClone(persistentStore.analyses[0]);

    const second = await processNextIntentJob({
      store: persistentStore,
      analyse: analyserReturning(
        intentResult({ classification: { value: "atomic", confidence: 0.95 } }),
        "claude-sonnet-5",
      ),
    });

    expect(persistentStore.analyses).toHaveLength(2);
    expect(persistentStore.analyses[0]).toStrictEqual(firstRun);
    expect(persistentStore.analyses[1].modelId).toBe("claude-sonnet-5");
    expect(first).toHaveProperty("analysisId", "analysis-1");
    expect(second).toHaveProperty("analysisId", "analysis-2");
  });

  it("AC5 enqueues exactly one pending source-resolution job when resolution is required", async () => {
    const outcome = await processNextIntentJob({
      store,
      analyse: analyserReturning(intentResult({ resolutionRequired: true })),
    });

    expect(outcome).toHaveProperty("resolutionJobId", "resolution-1");
    expect(store.jobs.filter((job) => job.jobType === "source_resolution")).toHaveLength(1);
  });

  it("AC5 adds no second job when an equivalent pending source-resolution job exists", async () => {
    const withPending = createFakeStore({ pendingJobs: 1 });

    const outcome = await processNextIntentJob({
      store: withPending,
      analyse: analyserReturning(intentResult({ resolutionRequired: true })),
    });

    expect(outcome).not.toHaveProperty("resolutionJobId");
    expect(withPending.jobs.filter((job) => job.jobType === "source_resolution")).toHaveLength(1);
  });

  it("AC5 adds no source-resolution job when resolution is not required", async () => {
    await processNextIntentJob({
      store,
      analyse: analyserReturning(intentResult({ resolutionRequired: false })),
    });

    expect(store.jobs.filter((job) => job.jobType === "source_resolution")).toStrictEqual([]);
  });

  it("AC3 returns the job to the queue when its capture has since been deleted", async () => {
    const orphaned = createFakeStore();
    orphaned.loadCapture = async () => undefined;
    const analyse = vi.fn<IntentAnalyser>();

    const outcome = await processNextIntentJob({ store: orphaned, analyse });

    expect(outcome).toStrictEqual({
      status: "failed",
      jobId: "job-1",
      captureId: "capture-9",
      errorCode: "capture_missing",
    });
    expect(analyse).not.toHaveBeenCalled();
    expect(orphaned.analyses).toStrictEqual([]);
    expect(orphaned.releases).toStrictEqual([{ jobId: "job-1", message: "capture_missing" }]);
  });
});
