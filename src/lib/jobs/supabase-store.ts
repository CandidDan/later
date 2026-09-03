import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureJobStore,
  CaptureJobType,
  CaptureRecord,
  JsonValue,
} from "./types";

interface QueryOutcome {
  data: unknown;
  error: { message: string } | null;
}

interface FilterBuilder extends PromiseLike<QueryOutcome> {
  eq(column: string, value: unknown): FilterBuilder;
  lte(column: string, value: unknown): FilterBuilder;
  order(column: string, options: { ascending: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
}

interface MutationBuilder extends PromiseLike<QueryOutcome> {
  eq(column: string, value: unknown): MutationBuilder;
  select(columns: string): FilterBuilder;
}

interface TableBuilder {
  select(columns: string): FilterBuilder;
  insert(values: Record<string, unknown>): MutationBuilder;
  update(values: Record<string, unknown>): MutationBuilder;
}

/** The subset of a PostgREST client this store uses, mirroring the capture-persistence shape. */
export interface CaptureJobTableClient {
  from(table: "captures" | "capture_assets" | "capture_analyses" | "capture_jobs"): TableBuilder;
}

function rowsFrom(outcome: QueryOutcome, action: string): Record<string, unknown>[] {
  if (outcome.error) {
    throw new Error(`Failed to ${action}: ${outcome.error.message}`);
  }

  if (!Array.isArray(outcome.data)) {
    throw new Error(`Failed to ${action}: expected a row set`);
  }

  return outcome.data as Record<string, unknown>[];
}

function requireString(row: Record<string, unknown>, column: string): string {
  const value = row[column];

  if (typeof value !== "string") {
    throw new Error(`Column ${column} is missing from the returned row`);
  }

  return value;
}

function optionalString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/**
 * Persistence for intent processing over Supabase.
 *
 * Claiming is a conditional update rather than a plain read: the row is only handed over if it
 * is still `pending` when the update lands, so two concurrent processors cannot both take the
 * same job. Analyses are inserted and never updated — a run is evidence, and evidence is
 * appended.
 */
export function createSupabaseCaptureJobStore(client: CaptureJobTableClient): CaptureJobStore {
  return {
    async claimNextJob(jobType: CaptureJobType): Promise<CaptureJob | undefined> {
      const candidates = rowsFrom(
        await client
          .from("capture_jobs")
          .select("id, capture_id, attempts")
          .eq("job_type", jobType)
          .eq("status", "pending")
          .lte("available_at", new Date().toISOString())
          .order("available_at", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(1),
        "read pending capture jobs",
      );

      if (candidates.length === 0) {
        return undefined;
      }

      const candidateId = requireString(candidates[0], "id");
      const attempts = Number(candidates[0].attempts ?? 0);
      const claimed = rowsFrom(
        await client
          .from("capture_jobs")
          .update({
            status: "processing",
            attempts: attempts + 1,
            locked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidateId)
          .eq("status", "pending")
          .select("id, capture_id, attempts"),
        "claim a capture job",
      );

      if (claimed.length === 0) {
        return undefined;
      }

      return {
        id: requireString(claimed[0], "id"),
        captureId: requireString(claimed[0], "capture_id"),
        jobType,
        attempts: Number(claimed[0].attempts ?? attempts + 1),
      };
    },

    async loadCapture(captureId: string): Promise<CaptureRecord | undefined> {
      const captures = rowsFrom(
        await client
          .from("captures")
          .select(
            "id, capture_channel, capture_kind, raw_text, user_note, source_platform, captured_at, raw_payload",
          )
          .eq("id", captureId)
          .limit(1),
        "read the capture",
      );

      if (captures.length === 0) {
        return undefined;
      }

      const assets = rowsFrom(
        await client
          .from("capture_assets")
          .select("filename, media_type, byte_size")
          .eq("capture_id", captureId)
          .order("created_at", { ascending: true }),
        "read the capture assets",
      );

      const capture = captures[0];

      return {
        id: requireString(capture, "id"),
        channel: requireString(capture, "capture_channel"),
        captureKind: requireString(capture, "capture_kind"),
        rawText: optionalString(capture, "raw_text"),
        userNote: optionalString(capture, "user_note"),
        sourcePlatform: optionalString(capture, "source_platform"),
        capturedAt: requireString(capture, "captured_at"),
        rawPayload: jsonObject(capture.raw_payload),
        assets: assets.map((asset) => ({
          filename: requireString(asset, "filename"),
          mediaType: optionalString(asset, "media_type"),
          byteSize: typeof asset.byte_size === "number" ? asset.byte_size : null,
        })),
      };
    },

    async appendAnalysis(record: AnalysisRecordInput): Promise<string> {
      const inserted = rowsFrom(
        await client
          .from("capture_analyses")
          .insert({
            capture_id: record.captureId,
            analysis_type: "intent",
            status: record.status,
            input_snapshot: record.inputSnapshot,
            result: record.result,
            confidence: record.confidence,
            model_id: record.modelId,
            prompt_version: record.promptVersion,
            pipeline_version: record.pipelineVersion,
            error_code: record.errorCode,
          })
          .select("id"),
        "append the capture analysis",
      );

      if (inserted.length === 0) {
        throw new Error("Failed to append the capture analysis: no row was returned");
      }

      return requireString(inserted[0], "id");
    },

    async completeJob(jobId: string): Promise<void> {
      const completedAt = new Date().toISOString();

      rowsFrom(
        await client
          .from("capture_jobs")
          .update({
            status: "completed",
            completed_at: completedAt,
            locked_at: null,
            last_error: null,
            updated_at: completedAt,
          })
          .eq("id", jobId)
          .select("id"),
        "complete the capture job",
      );
    },

    async releaseJob(jobId: string, errorMessage: string): Promise<void> {
      rowsFrom(
        await client
          .from("capture_jobs")
          .update({
            status: "pending",
            locked_at: null,
            last_error: errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId)
          .select("id"),
        "return the capture job to the queue",
      );
    },

    async countPendingJobs(captureId: string, jobType: CaptureJobType): Promise<number> {
      return rowsFrom(
        await client
          .from("capture_jobs")
          .select("id")
          .eq("capture_id", captureId)
          .eq("job_type", jobType)
          .eq("status", "pending"),
        "count pending capture jobs",
      ).length;
    },

    async enqueueJob(captureId: string, jobType: CaptureJobType): Promise<string> {
      const inserted = rowsFrom(
        await client
          .from("capture_jobs")
          .insert({ capture_id: captureId, job_type: jobType, status: "pending" })
          .select("id"),
        "enqueue a capture job",
      );

      if (inserted.length === 0) {
        throw new Error("Failed to enqueue a capture job: no row was returned");
      }

      return requireString(inserted[0], "id");
    },
  };
}
