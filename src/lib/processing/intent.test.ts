import { beforeEach, describe, expect, it, vi } from "vitest";

import { processNextIntentJob } from "./intent";
import { buildIntentInputSnapshot } from "./intent-input";
import { IntentResultSchemaError, type IntentResult } from "./intent-result";
import { IntentAnalysisError } from "./errors";
import { PIPELINE_VERSION, PROMPT_VERSION } from "./prompt";
import type { IntentAnalyser } from "./anthropic";
import type { AnthropicFailureDiagnostic } from "./failure-diagnostics";
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
    async finishAttempt(job, record, errorCode) {
      if (record) analyses.push(record);
      if (errorCode) {
        releases.push({ jobId: job.id, message: errorCode });
        return { analysisId: record ? `analysis-${analyses.length}` : null };
      }
      completed.push(job.id);
      let resolutionJobId: string | undefined;
      if (record?.result?.resolutionRequired && !jobs.some(j => j.jobType === "source_resolution" && j.status === "pending")) {
        resolutionJobId = `resolution-${++enqueued}`;
        jobs.push({ id: resolutionJobId, captureId: job.captureId, jobType: "source_resolution", status: "pending" });
      }
      return { analysisId: `analysis-${analyses.length}`, ...(resolutionJobId ? { resolutionJobId } : {}) };
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
    ["an Anthropic authentication failure", Object.assign(new Error("private auth detail"), { status: 401 }), "provider_unavailable"],
    ["an Anthropic rate limit", Object.assign(new Error("private rate detail"), { status: 429 }), "provider_unavailable"],
    ["an Anthropic outage", Object.assign(new Error("upstream down"), { status: 503 }), "provider_unavailable"],
    ["an Anthropic network failure", new Error("private network detail"), "provider_unavailable"],
  ])(
    "later-0013 AC4/AC5 records %s as a failed attempt and leaves the job retryable",
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

  it("later-0013 AC5 records HTTP 400's mapped failure without provider or capture text", async () => {
    await processNextIntentJob({
      store,
      analyse: async () => {
        throw new IntentAnalysisError("model said: the bit about sourdough starters");
      },
    });

    expect(store.releases[0].message).toBe("provider_response_invalid");
    expect(store.releases[0].message).not.toContain("sourdough");
  });

  it("AC3 leaves a prior successful analysis untouched when a later run fails", async () => {
    const persistentStore = createFakeStore();
    let nextJob = 0;
    persistentStore.claimNextJob = async (jobType) => ({
      id: `job-${++nextJob}`,
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

  it("AC4 appends a distinct record for a second intent job and never edits the first", async () => {
    const persistentStore = createFakeStore();
    let nextJob = 0;
    persistentStore.claimNextJob = async (jobType) => ({
      id: `job-${++nextJob}`,
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
  it("AC5 a late worker cannot report a success after its lease is recovered", async () => {
    store.finishAttempt = async () => undefined;
    const outcome = await processNextIntentJob({ store, analyse: analyserReturning(intentResult()) });
    expect(outcome).toMatchObject({ status: "failed", errorCode: "lease_lost" });
    expect(store.analyses).toEqual([]);
    expect(store.completed).toEqual([]);
  });

  it("AC3 hostile provider error names and messages are never persisted", async () => {
    const error = new Error("private credential and capture text");
    error.name = "private credential and capture text";
    await processNextIntentJob({ store, analyse: async () => { throw error; } });
    expect(store.releases).toEqual([{ jobId: "job-1", message: "provider_unavailable" }]);
    expect(store.analyses[0].errorCode).toBe("provider_unavailable");
  });

});

describe("later-0014 failure diagnostics", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore();
  });

  function recorder(): { events: AnthropicFailureDiagnostic[]; emitDiagnostic: (event: AnthropicFailureDiagnostic) => void } {
    const events: AnthropicFailureDiagnostic[] = [];
    return { events, emitDiagnostic: (event) => { events.push(event); } };
  }

  it.each([
    ["authentication", Object.assign(new Error("invalid x-api-key"), { name: "AuthenticationError", status: 401 }), "authentication", 401, false],
    ["model access", Object.assign(new Error("model not permitted"), { name: "PermissionDeniedError", status: 403 }), "permission", 403, false],
    ["rate limiting", Object.assign(new Error("slow down"), { name: "RateLimitError", status: 429 }), "rate_limit", 429, true],
    ["a provider 5xx", Object.assign(new Error("upstream down"), { name: "InternalServerError", status: 503 }), "provider_server", 503, true],
    ["a timeout", Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }), "timeout", undefined, true],
    ["a network failure", Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }), "network", undefined, true],
  ])(
    "AC1 emits exactly one diagnostic for %s, with the internal job and capture ids",
    async (_label, failure, category, status, retryable) => {
      const sink = recorder();

      await processNextIntentJob({
        store,
        analyse: async () => { throw failure; },
        ...sink,
      });

      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toStrictEqual({
        event: "intent_provider_failure",
        provider: "anthropic",
        operation: "intent_analysis",
        jobId: "job-1",
        captureId: "capture-9",
        category,
        retryable,
        ...(status === undefined ? {} : { status }),
      });
    },
  );

  it("AC2 carries a well-formed provider request id through to the diagnostic", async () => {
    const sink = recorder();

    await processNextIntentJob({
      store,
      analyse: async () => {
        throw Object.assign(new Error("slow down"), {
          name: "RateLimitError",
          status: 429,
          request_id: "req_011CSHoEeqs5C35K2UUqR6c6",
        });
      },
      ...sink,
    });

    expect(sink.events[0]).toMatchObject({ requestId: "req_011CSHoEeqs5C35K2UUqR6c6" });
  });

  it("AC2 omits a malformed request id instead of copying it into the event", async () => {
    const sink = recorder();

    await processNextIntentJob({
      store,
      analyse: async () => {
        throw Object.assign(new Error("slow down"), {
          name: "RateLimitError",
          status: 429,
          request_id: "Bearer sk-ant-api03-SUPERSECRET",
        });
      },
      ...sink,
    });

    expect(sink.events[0]).not.toHaveProperty("requestId");
    expect(JSON.stringify(sink.events[0])).not.toContain("SUPERSECRET");
  });

  it("AC3 emits no provider text, credential or captured content anywhere in the event", async () => {
    const sink = recorder();

    await processNextIntentJob({
      store,
      analyse: async () => {
        throw Object.assign(new Error("invalid x-api-key sk-ant-api03-SUPERSECRET"), {
          name: "AuthenticationError",
          status: 401,
          stack: "at the bit about sourdough starters",
          cause: new Error("https://www.youtube.com/watch?v=abc"),
          headers: { authorization: "Bearer sk-ant-api03-SUPERSECRET" },
          request: { body: { messages: [{ content: "the bit about sourdough starters" }] } },
          response: { body: { error: { message: "sk-ant-api03-SUPERSECRET" } } },
        });
      },
      ...sink,
    });

    const serialised = JSON.stringify(sink.events[0]);

    for (const secret of ["SUPERSECRET", "sourdough", "youtube.com", "x-api-key", "Bearer"]) {
      expect(serialised).not.toContain(secret);
    }
    expect(Object.keys(sink.events[0])).toStrictEqual([
      "event", "provider", "operation", "jobId", "captureId", "category", "retryable", "status",
    ]);
  });

  it.each([
    ["a bare string", "sk-ant-api03-SUPERSECRET"],
    ["null", null],
    ["a non-Error object", { message: "sk-ant-api03-SUPERSECRET" }],
  ])("AC4 records %s as a bounded unknown diagnostic and still finishes the attempt", async (_label, thrown) => {
    const sink = recorder();

    const outcome = await processNextIntentJob({
      store,
      analyse: async () => { throw thrown; },
      ...sink,
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ category: "unknown", retryable: false });
    expect(JSON.stringify(sink.events[0])).not.toContain("SUPERSECRET");
    expect(outcome).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  it("AC4 finishes the attempt normally when the diagnostic sink itself throws", async () => {
    const outcome = await processNextIntentJob({
      store,
      analyse: async () => { throw Object.assign(new Error("slow down"), { status: 429 }); },
      emitDiagnostic: () => { throw new Error("logging is down"); },
    });

    expect(outcome).toStrictEqual({
      status: "failed",
      jobId: "job-1",
      captureId: "capture-9",
      errorCode: "provider_unavailable",
    });
    expect(store.analyses[0].errorCode).toBe("provider_unavailable");
  });

  it.each([
    ["a transport failure", Object.assign(new Error("invalid x-api-key"), { status: 401 }), "provider_unavailable"],
    ["an unusable response", new IntentAnalysisError("declined"), "provider_response_invalid"],
    ["a schema-invalid result", new IntentResultSchemaError("contentType must be one of"), "result_schema_invalid"],
  ])(
    "AC5 leaves the stored code, analysis record and retry hand-back unchanged for %s",
    async (_label, failure, expectedCode) => {
      const sink = recorder();
      const finished: Array<{ attempts: number; errorCode: string | undefined }> = [];
      const attemptStore = createFakeStore();
      let attempt = 0;
      attemptStore.claimNextJob = async (jobType) => ({
        id: "job-1",
        captureId: capture.id,
        jobType,
        attempts: ++attempt,
      });
      const finishAttempt = attemptStore.finishAttempt.bind(attemptStore);
      attemptStore.finishAttempt = async (job, record, errorCode) => {
        finished.push({ attempts: job.attempts, errorCode });
        return finishAttempt(job, record, errorCode);
      };

      for (let run = 0; run < 3; run += 1) {
        await processNextIntentJob({
          store: attemptStore,
          analyse: async () => { throw failure; },
          ...sink,
        });
      }

      // Three attempts handed back to the queue with their attempt counter intact: the
      // database's `attempts >= 3` retry schedule still sees exactly what it saw before.
      expect(finished).toStrictEqual([
        { attempts: 1, errorCode: expectedCode },
        { attempts: 2, errorCode: expectedCode },
        { attempts: 3, errorCode: expectedCode },
      ]);
      expect(attemptStore.completed).toStrictEqual([]);
      expect(attemptStore.analyses).toHaveLength(3);
      for (const record of attemptStore.analyses) {
        expect(record).toStrictEqual({
          captureId: "capture-9",
          status: "failed",
          inputSnapshot: buildIntentInputSnapshot(capture),
          result: null,
          confidence: null,
          modelId: null,
          promptVersion: PROMPT_VERSION,
          pipelineVersion: PIPELINE_VERSION,
          errorCode: expectedCode,
        });
      }
      expect(sink.events).toHaveLength(3);
    },
  );

  it("AC1 names the enriched operation when the enriched phase fails", async () => {
    const sink = recorder();
    const enrichedStore = createFakeStore();
    enrichedStore.claimNextJob = async (jobType) => ({
      id: "job-1",
      captureId: capture.id,
      jobType,
      attempts: 1,
      intentPhase: "enriched",
    });

    await processNextIntentJob({
      store: enrichedStore,
      analyse: async () => { throw Object.assign(new Error("slow down"), { status: 429 }); },
      ...sink,
    });

    expect(sink.events[0]).toMatchObject({ operation: "intent_analysis_enriched", category: "rate_limit" });
  });
});
