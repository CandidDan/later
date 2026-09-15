import { describe, expect, it } from "vitest";

import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";

interface RecordedCall {
  table: string;
  operation: "select" | "insert" | "update" | "rpc";
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
      rpc: (name: string, args: Record<string, unknown>) => start(name, "rpc", args),
      from: (table: string) => ({
        select: () => start(table, "select"),
        insert: (values: Record<string, unknown>) => start(table, "insert", values),
        update: (values: Record<string, unknown>) => start(table, "update", values),
      }),
    } as unknown as CaptureJobTableClient,
  };
}

describe("createSupabaseCaptureJobStore", () => {
  it("claims only the atomic intent RPC and carries the fencing attempt", async () => {
    const { client, calls } = createFakeClient([{ data: [{ id: "job-1", capture_id: "capture-1", attempts: 2 }] }]);
    expect(await createSupabaseCaptureJobStore(client).claimNextJob("intent_analysis")).toEqual({
      id: "job-1", captureId: "capture-1", jobType: "intent_analysis", attempts: 2,
    });
    expect(calls).toEqual([{ table: "claim_intent_job", operation: "rpc", values: { p_job_type: "intent_analysis" }, filters: [] }]);
  });

  it("yields no job when an overlapping claim finds no eligible row", async () => {
    const { client } = createFakeClient([{ data: [] }]);
    expect(await createSupabaseCaptureJobStore(client).claimNextJob("intent_analysis")).toBeUndefined();
  });

  it("AC1 claims source work through its independent RPC with the selected intent id", async () => {
    const { client, calls } = createFakeClient([{ data: [{
      id: "source-job-1",
      capture_id: "capture-1",
      attempts: 1,
      intent_analysis_id: "intent-1",
    }] }]);
    expect(await createSupabaseCaptureJobStore(client).claimNextJob("source_resolution")).toEqual({
      id: "source-job-1",
      captureId: "capture-1",
      jobType: "source_resolution",
      attempts: 1,
      intentAnalysisId: "intent-1",
    });
    expect(calls).toEqual([{ table: "claim_source_resolution_job", operation: "rpc", values: {}, filters: [] }]);
  });

  it("sends the lease fence and safe failure in one finalization RPC", async () => {
    const { client, calls } = createFakeClient([{ data: [{ analysis_id: null, resolution_job_id: null }] }]);
    const store = createSupabaseCaptureJobStore(client);
    expect(await store.finishAttempt({ id: "job-1", captureId: "capture-1", jobType: "intent_analysis", attempts: 2 }, null, "capture_missing")).toEqual({ analysisId: null });
    expect(calls).toEqual([{ table: "finish_intent_attempt", operation: "rpc", values: {
      p_job_id: "job-1", p_attempt: 2, p_record: null, p_error_code: "capture_missing",
    }, filters: [] }]);
  });

  it("does not report success after losing the lease", async () => {
    const { client } = createFakeClient([{ data: [] }]);
    expect(await createSupabaseCaptureJobStore(client).finishAttempt({ id: "job-1", captureId: "capture-1", jobType: "intent_analysis", attempts: 1 }, null, "capture_missing")).toBeUndefined();
  });

  it("AC5 finalizes source work with the same lease fence and returns downstream work", async () => {
    const { client, calls } = createFakeClient([{ data: [{ analysis_id: "source-1", segment_job_id: "segment-1" }] }]);
    const result = await createSupabaseCaptureJobStore(client).finishAttempt({
      id: "source-job-1",
      captureId: "capture-1",
      jobType: "source_resolution",
      attempts: 2,
      intentAnalysisId: "intent-1",
    }, null, "provider_unavailable");
    expect(result).toStrictEqual({ analysisId: "source-1", segmentJobId: "segment-1" });
    expect(calls).toEqual([{ table: "finish_source_resolution_attempt", operation: "rpc", values: {
      p_job_id: "source-job-1", p_attempt: 2, p_record: null, p_error_code: "provider_unavailable",
    }, filters: [] }]);
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

  it("AC2 loads exactly the selected successful intent analysis", async () => {
    const { client, calls } = createFakeClient([{ data: [{
      id: "intent-1",
      capture_id: "capture-1",
      input_snapshot: { captureId: "capture-1" },
      result: { underlyingSource: { hints: ["episode"] } },
      confidence: 0.7,
      model_id: "intent-model",
      prompt_version: "intent-v1",
      pipeline_version: "intent-pipeline-v1",
    }] }]);
    expect(await createSupabaseCaptureJobStore(client).loadIntentAnalysis("intent-1", "capture-1"))
      .toStrictEqual({
        id: "intent-1",
        captureId: "capture-1",
        inputSnapshot: { captureId: "capture-1" },
        result: { underlyingSource: { hints: ["episode"] } },
        confidence: 0.7,
        modelId: "intent-model",
        promptVersion: "intent-v1",
        pipelineVersion: "intent-pipeline-v1",
      });
    expect(calls[0]).toMatchObject({
      table: "capture_analyses",
      operation: "select",
      filters: expect.arrayContaining([
        { kind: "eq", column: "id", value: "intent-1" },
        { kind: "eq", column: "capture_id", value: "capture-1" },
        { kind: "eq", column: "analysis_type", value: "intent" },
        { kind: "eq", column: "status", value: "succeeded" },
      ]),
    });
  });

  it("AC1 treats a missing capture as absent rather than as an empty capture", async () => {
    const { client } = createFakeClient([{ data: [] }]);

    expect(await createSupabaseCaptureJobStore(client).loadCapture("missing")).toBeUndefined();
  });
});
