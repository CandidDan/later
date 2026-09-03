import { describe, expect, it } from "vitest";

import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";

interface RecordedCall {
  table: string;
  operation: "select" | "insert" | "update";
  values?: Record<string, unknown>;
  filters: Array<{ kind: string; column: string; value: unknown }>;
}

interface FakeBuilder extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  eq(column: string, value: unknown): FakeBuilder;
  lte(column: string, value: unknown): FakeBuilder;
  order(column: string, options: { ascending: boolean }): FakeBuilder;
  limit(count: number): FakeBuilder;
  select(columns: string): FakeBuilder;
}

interface FakeClient {
  client: CaptureJobTableClient;
  calls: RecordedCall[];
}

function createFakeClient(
  responses: Array<{ data: unknown; error?: { message: string } }>,
): FakeClient {
  const calls: RecordedCall[] = [];
  let responseIndex = 0;

  function builder(call: RecordedCall): FakeBuilder {
    const record = (kind: string) => (column: string, value: unknown) => {
      call.filters.push({ kind, column, value });
      return self;
    };
    const self: FakeBuilder = {
      eq: record("eq"),
      lte: record("lte"),
      order: (column, options) => record("order")(column, options),
      limit: (count) => record("limit")("limit", count),
      select: () => self,
      then: (onFulfilled, onRejected) => {
        const response = responses[responseIndex] ?? { data: [] };
        responseIndex += 1;
        return Promise.resolve({
          data: response.data,
          error: response.error ?? null,
        }).then(onFulfilled, onRejected);
      },
    };

    return self;
  }

  function start(table: string, operation: RecordedCall["operation"], values?: Record<string, unknown>) {
    const call: RecordedCall = { table, operation, values, filters: [] };
    calls.push(call);
    return builder(call);
  }

  return {
    calls,
    client: {
      from: (table: string) => ({
        select: () => start(table, "select"),
        insert: (values: Record<string, unknown>) => start(table, "insert", values),
        update: (values: Record<string, unknown>) => start(table, "update", values),
      }),
    } as unknown as CaptureJobTableClient,
  };
}

describe("createSupabaseCaptureJobStore", () => {
  it("AC1 claims a job with a conditional update, so a claimed job cannot be taken twice", async () => {
    const { client, calls } = createFakeClient([
      { data: [{ id: "job-1", capture_id: "capture-1", attempts: 0 }] },
      { data: [{ id: "job-1", capture_id: "capture-1", attempts: 1 }] },
    ]);

    const job = await createSupabaseCaptureJobStore(client).claimNextJob("intent_analysis");

    expect(job).toStrictEqual({
      id: "job-1",
      captureId: "capture-1",
      jobType: "intent_analysis",
      attempts: 1,
    });
    expect(calls[1].operation).toBe("update");
    expect(calls[1].values).toMatchObject({ status: "processing", attempts: 1 });
    expect(calls[1].filters).toContainEqual({ kind: "eq", column: "status", value: "pending" });
  });

  it("AC1 yields no job when the conditional claim loses the race", async () => {
    const { client } = createFakeClient([
      { data: [{ id: "job-1", capture_id: "capture-1", attempts: 0 }] },
      { data: [] },
    ]);

    expect(
      await createSupabaseCaptureJobStore(client).claimNextJob("intent_analysis"),
    ).toBeUndefined();
  });

  it("AC4 writes an analysis with insert only, so a run can never overwrite a prior one", async () => {
    const { client, calls } = createFakeClient([{ data: [{ id: "analysis-1" }] }]);

    const id = await createSupabaseCaptureJobStore(client).appendAnalysis({
      captureId: "capture-1",
      status: "succeeded",
      inputSnapshot: { captureId: "capture-1" },
      result: { contentType: "video" },
      confidence: 0.6,
      modelId: "claude-haiku-4-5",
      promptVersion: "intent-v0.1",
      pipelineVersion: "intent-pipeline-v0.1",
      errorCode: null,
    });

    expect(id).toBe("analysis-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "capture_analyses", operation: "insert" });
    expect(calls[0].values).toMatchObject({
      analysis_type: "intent",
      model_id: "claude-haiku-4-5",
      prompt_version: "intent-v0.1",
      pipeline_version: "intent-pipeline-v0.1",
    });
  });

  it("AC3 returns a failed job to the queue as pending with its recorded error", async () => {
    const { client, calls } = createFakeClient([{ data: [{ id: "job-1" }] }]);

    await createSupabaseCaptureJobStore(client).releaseJob("job-1", "provider_unavailable (Error)");

    expect(calls[0].operation).toBe("update");
    expect(calls[0].values).toMatchObject({
      status: "pending",
      locked_at: null,
      last_error: "provider_unavailable (Error)",
    });
  });

  it("AC5 counts only pending jobs of the requested type for the capture", async () => {
    const { client, calls } = createFakeClient([{ data: [{ id: "a" }, { id: "b" }] }]);

    const count = await createSupabaseCaptureJobStore(client).countPendingJobs(
      "capture-1",
      "source_resolution",
    );

    expect(count).toBe(2);
    expect(calls[0].filters).toStrictEqual([
      { kind: "eq", column: "capture_id", value: "capture-1" },
      { kind: "eq", column: "job_type", value: "source_resolution" },
      { kind: "eq", column: "status", value: "pending" },
    ]);
  });

  it("AC5 enqueues a source-resolution job in the pending state", async () => {
    const { client, calls } = createFakeClient([{ data: [{ id: "resolution-1" }] }]);

    const id = await createSupabaseCaptureJobStore(client).enqueueJob(
      "capture-1",
      "source_resolution",
    );

    expect(id).toBe("resolution-1");
    expect(calls[0]).toMatchObject({ table: "capture_jobs", operation: "insert" });
    expect(calls[0].values).toStrictEqual({
      capture_id: "capture-1",
      job_type: "source_resolution",
      status: "pending",
    });
  });

  it("AC1 loads the capture with its assets and no retrospective columns", async () => {
    const { client, calls } = createFakeClient([
      {
        data: [
          {
            id: "capture-1",
            capture_channel: "whatsapp",
            capture_kind: "link",
            raw_text: "https://example.com",
            user_note: null,
            source_platform: null,
            captured_at: "2026-09-01T10:00:00.000Z",
            raw_payload: { NumSegments: "1" },
          },
        ],
      },
      { data: [{ filename: "clip.mp4", media_type: "video/mp4", byte_size: 10 }] },
    ]);

    const record = await createSupabaseCaptureJobStore(client).loadCapture("capture-1");

    expect(record).toStrictEqual({
      id: "capture-1",
      channel: "whatsapp",
      captureKind: "link",
      rawText: "https://example.com",
      userNote: null,
      sourcePlatform: null,
      capturedAt: "2026-09-01T10:00:00.000Z",
      rawPayload: { NumSegments: "1" },
      assets: [{ filename: "clip.mp4", mediaType: "video/mp4", byteSize: 10 }],
    });
    expect(calls[0].table).toBe("captures");
    expect(calls[1].table).toBe("capture_assets");
  });

  it("AC3 surfaces a database error instead of reporting a silent success", async () => {
    const { client } = createFakeClient([{ data: null, error: { message: "connection lost" } }]);

    await expect(
      createSupabaseCaptureJobStore(client).claimNextJob("intent_analysis"),
    ).rejects.toThrow(/connection lost/u);
  });

  it("AC1 treats a missing capture as absent rather than as an empty capture", async () => {
    const { client } = createFakeClient([{ data: [] }]);

    expect(await createSupabaseCaptureJobStore(client).loadCapture("missing")).toBeUndefined();
  });
});
