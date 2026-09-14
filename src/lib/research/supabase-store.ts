import { toCaptureContext } from "./evaluation";
import type {
  RatingOutcome,
  RatingSubmission,
  RecallOutcome,
  RecallSubmission,
  ResearchStore,
  RevealOutcome,
  RevealedRun,
} from "./types";

interface QueryOutcome {
  data: unknown;
  error: { message: string } | null;
}

interface FilterBuilder extends PromiseLike<QueryOutcome> {
  eq(column: string, value: unknown): FilterBuilder;
  in(column: string, values: readonly unknown[]): FilterBuilder;
  is(column: string, value: null): FilterBuilder;
  order(column: string, options: { ascending: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
  select(columns: string): FilterBuilder;
}

interface TableBuilder {
  select(columns: string): FilterBuilder;
  update(values: Record<string, unknown>): FilterBuilder;
  upsert(
    rows: readonly Record<string, unknown>[],
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): FilterBuilder;
}

export type ResearchTable =
  | "research_pending_evaluations"
  | "capture_assets"
  | "capture_analyses"
  | "capture_evaluations";

/** The subset of a PostgREST client this store uses, mirroring the capture-job store's shape. */
export interface ResearchTableClient {
  from(table: ResearchTable): TableBuilder;
}

/**
 * The capture-time columns the recall phase may read. Listed here rather than as `*` so that a
 * column added to the view later cannot silently become something the evaluator sees before
 * they have answered from memory.
 */
const CAPTURE_COLUMNS =
  "capture_id, capture_channel, capture_kind, raw_text, user_note, source_platform, captured_at, recall_stored";

function rowsFrom(outcome: QueryOutcome, action: string): Record<string, unknown>[] {
  if (outcome.error) {
    throw new Error(`Failed to ${action}: ${outcome.error.message}`);
  }

  if (!Array.isArray(outcome.data)) {
    throw new Error(`Failed to ${action}: expected a row set`);
  }

  return outcome.data as Record<string, unknown>[];
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];

  return typeof value === "string" ? value : "";
}

function toRevealedRun(
  evaluation: Record<string, unknown>,
  analysis: Record<string, unknown>,
): RevealedRun {
  return {
    evaluationId: text(evaluation, "id"),
    // The rating is bound to this id, never to "the capture's analysis": two runs of the same
    // capture are different evidence and have to stay separable after the fact.
    analysisId: text(analysis, "id"),
    modelId: text(analysis, "model_id"),
    promptVersion: text(analysis, "prompt_version"),
    pipelineVersion: text(analysis, "pipeline_version"),
    analysedAt: text(analysis, "created_at"),
    confidence: typeof analysis.confidence === "number" ? analysis.confidence : null,
    result: analysis.result ?? null,
    rated: typeof evaluation.rated_at === "string",
  };
}

/**
 * A research store bound to one evaluator. Every query still runs under that evaluator's own
 * credentials, so the `evaluator_id` filters below are narrowing, not the security boundary —
 * row-level security is, and it stays in force even if one of these filters is ever dropped.
 */
export function createSupabaseResearchStore(
  client: ResearchTableClient,
  evaluatorId: string,
): ResearchStore {
  async function successfulRunIds(captureId: string): Promise<string[]> {
    const rows = rowsFrom(
      await client
        .from("capture_analyses")
        .select("id")
        .eq("capture_id", captureId)
        .eq("analysis_type", "intent")
        .eq("status", "succeeded")
        .order("created_at", { ascending: true }),
      "select the capture's successful runs",
    );

    return rows.map((row) => text(row, "id"));
  }

  return {
    async nextUnevaluatedCapture() {
      const captures = rowsFrom(
        await client
          .from("research_pending_evaluations")
          .select(CAPTURE_COLUMNS)
          .eq("user_id", evaluatorId)
          // A persisted-but-incomplete evaluation must survive a refresh before fresh work.
          .order("recall_stored", { ascending: false })
          .order("captured_at", { ascending: true })
          .limit(1),
        "select the next capture to evaluate",
      );

      if (captures.length === 0) {
        return undefined;
      }

      const assets = rowsFrom(
        await client
          .from("capture_assets")
          .select("filename, media_type")
          .eq("capture_id", text(captures[0], "capture_id"))
          .order("created_at", { ascending: true }),
        "select the capture's assets",
      );

      return {
        capture: toCaptureContext({ ...captures[0], assets }),
        recallStored: captures[0].recall_stored === true,
      };
    },

    async recordRecall(submission: RecallSubmission): Promise<RecallOutcome | "no_eligible_runs"> {
      const runIds = await successfulRunIds(submission.captureId);

      if (runIds.length === 0) {
        return "no_eligible_runs";
      }

      const existing = rowsFrom(
        await client
          .from("capture_evaluations")
          .select("analysis_id")
          .eq("capture_id", submission.captureId)
          .eq("evaluator_id", evaluatorId),
        "read the stored recall answer",
      );
      const covered = new Set(existing.map((row) => text(row, "analysis_id")));
      const missing = runIds.filter((id) => !covered.has(id));

      if (missing.length > 0) {
        // One recall answer, reused across every run of the capture: the evaluator remembers
        // the capture, not a model. `ignoreDuplicates` makes a repeated submission a no-op
        // rather than a second, contradictory data point.
        rowsFrom(
          await client
            .from("capture_evaluations")
            .upsert(
              missing.map((analysisId) => ({
                capture_id: submission.captureId,
                analysis_id: analysisId,
                evaluator_id: evaluatorId,
                recall_status: submission.recallStatus,
                remembered_interest: submission.rememberedInterest,
              })),
              { onConflict: "evaluator_id,analysis_id", ignoreDuplicates: true },
            )
            .select("id"),
          "store the unaided recall answer",
        );
      }

      return { captureId: submission.captureId, runs: runIds.length, repeated: missing.length === 0 };
    },

    async revealRuns(captureId: string): Promise<RevealOutcome> {
      const evaluations = rowsFrom(
        await client
          .from("capture_evaluations")
          .select("id, analysis_id, revealed_at, rated_at")
          .eq("capture_id", captureId)
          .eq("evaluator_id", evaluatorId)
          .order("created_at", { ascending: true }),
        "read the stored recall answer",
      );

      // No stored recall means no reveal. The check is on persisted rows, not on a flag the
      // client sent, because the client is the party the reveal is being withheld from.
      if (evaluations.length === 0) {
        return { status: "recall_required" };
      }

      rowsFrom(
        await client
          .from("capture_evaluations")
          .update({ revealed_at: new Date().toISOString() })
          .eq("capture_id", captureId)
          .eq("evaluator_id", evaluatorId)
          .is("revealed_at", null)
          .select("id"),
        "record the reveal",
      );

      const analyses = rowsFrom(
        await client
          .from("capture_analyses")
          .select("id, result, confidence, model_id, prompt_version, pipeline_version, created_at")
          .in("id", evaluations.map((row) => text(row, "analysis_id"))),
        "read the frozen analyses",
      );
      const byId = new Map(analyses.map((row) => [text(row, "id"), row]));
      const runs = evaluations.flatMap((evaluation) => {
        const analysis = byId.get(text(evaluation, "analysis_id"));

        return analysis ? [toRevealedRun(evaluation, analysis)] : [];
      });

      return { status: "revealed", captureId, runs };
    },

    async recordRating(submission: RatingSubmission): Promise<RatingOutcome> {
      const existing = rowsFrom(
        await client
          .from("capture_evaluations")
          .select("id, revealed_at, rated_at")
          .eq("id", submission.evaluationId)
          .eq("evaluator_id", evaluatorId),
        "read the evaluation being rated",
      );

      if (existing.length === 0) {
        return { status: "unknown" };
      }

      if (typeof existing[0].revealed_at !== "string") {
        return { status: "not_revealed" };
      }

      if (typeof existing[0].rated_at === "string") {
        return { status: "rated", repeated: true };
      }

      const updated = rowsFrom(
        await client
          .from("capture_evaluations")
          .update({
            intent_accuracy: submission.intentAccuracy,
            still_interested: submission.stillInterested,
            consumed_before_evaluation: submission.consumedBeforeEvaluation,
            notes: submission.notes,
            rated_at: new Date().toISOString(),
          })
          .eq("id", submission.evaluationId)
          .eq("evaluator_id", evaluatorId)
          .is("rated_at", null)
          .select("id"),
        "store the rating",
      );

      // The conditional update also makes simultaneous retries idempotent.
      return { status: "rated", repeated: updated.length === 0 };
    },
  };
}
