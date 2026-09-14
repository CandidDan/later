import { describe, expect, it } from "vitest";

import { createSupabaseResearchStore, type ResearchTableClient } from "./supabase-store";

const EVALUATOR = "11111111-1111-1111-1111-111111111111";
const CAPTURE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const HAIKU_ANALYSIS = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const SONNET_ANALYSIS = "cccccccc-cccc-cccc-cccc-ccccccccccc2";
const HAIKU_EVALUATION = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";
const SONNET_EVALUATION = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2";

interface Call {
  table: string;
  operation: "select" | "update" | "upsert";
  columns?: string;
  values?: Record<string, unknown>;
  rows?: readonly Record<string, unknown>[];
  filters: { kind: string; column: string; value: unknown }[];
}

/**
 * A PostgREST stand-in that records what was asked for. Responses are keyed by table and
 * operation so a test can describe the database state rather than a call sequence.
 */
function fakeClient(responses: Record<string, unknown[]>): {
  client: ResearchTableClient;
  calls: Call[];
} {
  const calls: Call[] = [];

  function builder(call: Call) {
    const self = {
      eq(column: string, value: unknown) {
        call.filters.push({ kind: "eq", column, value });
        return self;
      },
      in(column: string, value: readonly unknown[]) {
        call.filters.push({ kind: "in", column, value });
        return self;
      },
      is(column: string, value: null) {
        call.filters.push({ kind: "is", column, value });
        return self;
      },
      order(column: string, options: { ascending: boolean }) {
        call.filters.push({ kind: "order", column, value: options.ascending });
        return self;
      },
      limit(count: number) {
        call.filters.push({ kind: "limit", column: "", value: count });
        return self;
      },
      select(columns: string) {
        call.columns ??= columns;
        return self;
      },
      then<T>(resolve: (outcome: { data: unknown; error: null }) => T) {
        const key = `${call.table}:${call.operation}`;
        return Promise.resolve(resolve({ data: responses[key] ?? [], error: null }));
      },
    };

    return self;
  }

  return {
    calls,
    client: {
      from(table) {
        return {
          select(columns: string) {
            const call: Call = { table, operation: "select", columns, filters: [] };
            calls.push(call);
            return builder(call);
          },
          update(values: Record<string, unknown>) {
            const call: Call = { table, operation: "update", values, filters: [] };
            calls.push(call);
            return builder(call);
          },
          upsert(rows: readonly Record<string, unknown>[]) {
            const call: Call = { table, operation: "upsert", rows, filters: [] };
            calls.push(call);
            return builder(call);
          },
        };
      },
    } as ResearchTableClient,
  };
}

function callsTo(calls: Call[], table: string, operation: Call["operation"]): Call[] {
  return calls.filter((call) => call.table === table && call.operation === operation);
}

describe("supabase research store", () => {
  it("AC2 selects the next capture without reading any analysis column", async () => {
    const { client, calls } = fakeClient({
      "research_pending_evaluations:select": [
        {
          capture_id: CAPTURE_ID,
          capture_channel: "whatsapp",
          capture_kind: "url",
          raw_text: "https://example.test/pasta",
          user_note: null,
          source_platform: null,
          captured_at: "2026-09-01T10:00:00Z",
        },
      ],
      "capture_assets:select": [{ filename: "photo.jpg", media_type: "image/jpeg" }],
    });

    const capture = await createSupabaseResearchStore(client, EVALUATOR).nextUnevaluatedCapture();

    expect(capture).toEqual({
      captureId: CAPTURE_ID,
      channel: "whatsapp",
      captureKind: "url",
      rawText: "https://example.test/pasta",
      userNote: null,
      sourcePlatform: null,
      capturedAt: "2026-09-01T10:00:00Z",
      assets: [{ filename: "photo.jpg", mediaType: "image/jpeg" }],
    });
    expect(calls.map((call) => call.table)).not.toContain("capture_analyses");
    expect(calls[0].columns).not.toMatch(/result|model_id|confidence|prompt_version/u);
    expect(calls[0].filters).toContainEqual({ kind: "limit", column: "", value: 1 });
  });

  it("AC6 reports no capture rather than inventing one when the view is empty", async () => {
    const { client } = fakeClient({});

    await expect(
      createSupabaseResearchStore(client, EVALUATOR).nextUnevaluatedCapture(),
    ).resolves.toBeUndefined();
  });

  it("AC5 stores one recall answer against every successful run of the capture", async () => {
    const { client, calls } = fakeClient({
      "capture_analyses:select": [{ id: HAIKU_ANALYSIS }, { id: SONNET_ANALYSIS }],
      "capture_evaluations:upsert": [{ id: HAIKU_EVALUATION }, { id: SONNET_EVALUATION }],
    });

    const outcome = await createSupabaseResearchStore(client, EVALUATOR).recordRecall({
      captureId: CAPTURE_ID,
      recallStatus: "remembered",
      rememberedInterest: "the pasta recipe",
    });

    expect(outcome).toEqual({ captureId: CAPTURE_ID, runs: 2, repeated: false });
    expect(callsTo(calls, "capture_evaluations", "upsert")[0].rows).toEqual([
      {
        capture_id: CAPTURE_ID,
        analysis_id: HAIKU_ANALYSIS,
        evaluator_id: EVALUATOR,
        recall_status: "remembered",
        remembered_interest: "the pasta recipe",
      },
      {
        capture_id: CAPTURE_ID,
        analysis_id: SONNET_ANALYSIS,
        evaluator_id: EVALUATOR,
        recall_status: "remembered",
        remembered_interest: "the pasta recipe",
      },
    ]);
  });

  it("AC6 writes nothing when the same recall is submitted again", async () => {
    const { client, calls } = fakeClient({
      "capture_analyses:select": [{ id: HAIKU_ANALYSIS }, { id: SONNET_ANALYSIS }],
      "capture_evaluations:select": [
        { analysis_id: HAIKU_ANALYSIS },
        { analysis_id: SONNET_ANALYSIS },
      ],
    });

    const outcome = await createSupabaseResearchStore(client, EVALUATOR).recordRecall({
      captureId: CAPTURE_ID,
      recallStatus: "partial",
      rememberedInterest: null,
    });

    expect(outcome).toEqual({ captureId: CAPTURE_ID, runs: 2, repeated: true });
    expect(callsTo(calls, "capture_evaluations", "upsert")).toEqual([]);
  });

  it("AC6 refuses a recall for a capture with no successful run", async () => {
    const { client, calls } = fakeClient({ "capture_analyses:select": [] });

    await expect(
      createSupabaseResearchStore(client, EVALUATOR).recordRecall({
        captureId: CAPTURE_ID,
        recallStatus: "remembered",
        rememberedInterest: "something",
      }),
    ).resolves.toBe("no_eligible_runs");
    expect(callsTo(calls, "capture_evaluations", "upsert")).toEqual([]);
  });

  it("AC4 refuses the reveal, and reads no analysis, while no recall row exists", async () => {
    const { client, calls } = fakeClient({ "capture_evaluations:select": [] });

    await expect(
      createSupabaseResearchStore(client, EVALUATOR).revealRuns(CAPTURE_ID),
    ).resolves.toEqual({ status: "recall_required" });
    expect(callsTo(calls, "capture_analyses", "select")).toEqual([]);
    expect(callsTo(calls, "capture_evaluations", "update")).toEqual([]);
  });

  it("AC4/AC5 reveals each stored run bound to its own analysis and provenance", async () => {
    const { client, calls } = fakeClient({
      "capture_evaluations:select": [
        { id: HAIKU_EVALUATION, analysis_id: HAIKU_ANALYSIS, revealed_at: null, rated_at: null },
        {
          id: SONNET_EVALUATION,
          analysis_id: SONNET_ANALYSIS,
          revealed_at: "2026-09-14T07:00:00Z",
          rated_at: "2026-09-14T07:05:00Z",
        },
      ],
      "capture_evaluations:update": [{ id: HAIKU_EVALUATION }],
      "capture_analyses:select": [
        {
          id: SONNET_ANALYSIS,
          result: { interest: "sonnet" },
          confidence: 0.7,
          model_id: "claude-sonnet-5",
          prompt_version: "v2",
          pipeline_version: "v1",
          created_at: "2026-09-01T10:02:00Z",
        },
        {
          id: HAIKU_ANALYSIS,
          result: { interest: "haiku" },
          confidence: 0.9,
          model_id: "claude-haiku-4-5",
          prompt_version: "v1",
          pipeline_version: "v1",
          created_at: "2026-09-01T10:01:00Z",
        },
      ],
    });

    const outcome = await createSupabaseResearchStore(client, EVALUATOR).revealRuns(CAPTURE_ID);

    expect(outcome).toEqual({
      status: "revealed",
      captureId: CAPTURE_ID,
      runs: [
        {
          evaluationId: HAIKU_EVALUATION,
          analysisId: HAIKU_ANALYSIS,
          modelId: "claude-haiku-4-5",
          promptVersion: "v1",
          pipelineVersion: "v1",
          analysedAt: "2026-09-01T10:01:00Z",
          confidence: 0.9,
          result: { interest: "haiku" },
          rated: false,
        },
        {
          evaluationId: SONNET_EVALUATION,
          analysisId: SONNET_ANALYSIS,
          modelId: "claude-sonnet-5",
          promptVersion: "v2",
          pipelineVersion: "v1",
          analysedAt: "2026-09-01T10:02:00Z",
          confidence: 0.7,
          result: { interest: "sonnet" },
          rated: true,
        },
      ],
    });
    // The reveal is recorded server-side, and only for runs not already revealed.
    const [update] = callsTo(calls, "capture_evaluations", "update");
    expect(update.values).toEqual({ revealed_at: expect.any(String) });
    expect(update.filters).toContainEqual({ kind: "is", column: "revealed_at", value: null });
    // Nothing here writes to capture_analyses: the run being judged stays frozen.
    expect(callsTo(calls, "capture_analyses", "update")).toEqual([]);
  });

  it("AC5 records a rating against one evaluation row without touching the analysis", async () => {
    const { client, calls } = fakeClient({
      "capture_evaluations:select": [
        { id: HAIKU_EVALUATION, revealed_at: "2026-09-14T07:00:00Z" },
      ],
      "capture_evaluations:update": [{ id: HAIKU_EVALUATION }],
    });

    await expect(
      createSupabaseResearchStore(client, EVALUATOR).recordRating({
        evaluationId: HAIKU_EVALUATION,
        intentAccuracy: "close",
        stillInterested: true,
        consumedBeforeEvaluation: false,
        notes: null,
      }),
    ).resolves.toEqual({ status: "rated" });

    const [update] = callsTo(calls, "capture_evaluations", "update");
    expect(update.values).toMatchObject({
      intent_accuracy: "close",
      still_interested: true,
      consumed_before_evaluation: false,
      notes: null,
    });
    expect(update.filters).toContainEqual({ kind: "eq", column: "id", value: HAIKU_EVALUATION });
    expect(update.filters).toContainEqual({ kind: "eq", column: "evaluator_id", value: EVALUATOR });
    expect(callsTo(calls, "capture_analyses", "update")).toEqual([]);
  });

  it("AC6 refuses a rating for an unknown row or one that was never revealed", async () => {
    const unknown = fakeClient({ "capture_evaluations:select": [] });
    const unrevealed = fakeClient({
      "capture_evaluations:select": [{ id: HAIKU_EVALUATION, revealed_at: null }],
    });
    const rating = {
      evaluationId: HAIKU_EVALUATION,
      intentAccuracy: "correct" as const,
      stillInterested: true,
      consumedBeforeEvaluation: false,
      notes: null,
    };

    await expect(
      createSupabaseResearchStore(unknown.client, EVALUATOR).recordRating(rating),
    ).resolves.toEqual({ status: "unknown" });
    await expect(
      createSupabaseResearchStore(unrevealed.client, EVALUATOR).recordRating(rating),
    ).resolves.toEqual({ status: "not_revealed" });
    expect(callsTo(unknown.calls, "capture_evaluations", "update")).toEqual([]);
    expect(callsTo(unrevealed.calls, "capture_evaluations", "update")).toEqual([]);
  });

  it("AC6 turns a database error into a failure instead of an empty result", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
            }),
          }),
        }),
      }),
    } as unknown as ResearchTableClient;

    await expect(
      createSupabaseResearchStore(client, EVALUATOR).nextUnevaluatedCapture(),
    ).rejects.toThrow(/Failed to select the next capture/u);
  });
});
