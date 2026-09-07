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
  order(column: string, options: { ascending: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
}

interface TableBuilder {
  select(columns: string): FilterBuilder;
}

/** The subset of a PostgREST client this store uses, mirroring the capture-persistence shape. */
export interface CaptureJobTableClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<QueryOutcome>;
  from(table: "captures" | "capture_assets"): TableBuilder;
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

/** Claims and finalization are database transactions, fenced by the claimed attempt. */
export function createSupabaseCaptureJobStore(client: CaptureJobTableClient): CaptureJobStore {
  return {
    async claimNextJob(jobType: CaptureJobType): Promise<CaptureJob | undefined> {
      const claimed = rowsFrom(
        await client.rpc("claim_intent_job", { p_job_type: jobType }),
        "claim a capture job",
      );
      if (claimed.length === 0) return undefined;
      return {
        id: requireString(claimed[0], "id"),
        captureId: requireString(claimed[0], "capture_id"),
        jobType,
        attempts: Number(claimed[0].attempts),
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

    async finishAttempt(job: CaptureJob, record: AnalysisRecordInput | null, errorCode?: string) {
      const finished = rowsFrom(
        await client.rpc("finish_intent_attempt", {
          p_job_id: job.id,
          p_attempt: job.attempts,
          p_record: record,
          p_error_code: errorCode ?? null,
        }),
        "finish the capture attempt",
      );
      if (finished.length === 0) return undefined;
      const resolutionJobId = optionalString(finished[0], "resolution_job_id");
      return {
        analysisId: optionalString(finished[0], "analysis_id"),
        ...(resolutionJobId === null ? {} : { resolutionJobId }),
      };
    },
  };
}
