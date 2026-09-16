import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureJobType,
  CaptureRecord,
  JsonValue,
  SegmentResolutionJobStore,
  StoredIntentAnalysis,
  StoredSourceAnalysis,
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
  from(table: "captures" | "capture_assets" | "capture_analyses"): TableBuilder;
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
export function createSupabaseCaptureJobStore(client: CaptureJobTableClient): SegmentResolutionJobStore {
  return {
    async claimNextJob(jobType: CaptureJobType): Promise<CaptureJob | undefined> {
      const rpcName = jobType === "source_resolution"
        ? "claim_source_resolution_job"
        : jobType === "segment_resolution"
          ? "claim_segment_resolution_job"
          : "claim_intent_job";
      const claimed = rowsFrom(
        await client.rpc(
          rpcName,
          jobType === "source_resolution" || jobType === "segment_resolution"
            ? {}
            : { p_job_type: jobType },
        ),
        "claim a capture job",
      );
      if (claimed.length === 0) return undefined;
      return {
        id: requireString(claimed[0], "id"),
        captureId: requireString(claimed[0], "capture_id"),
        jobType,
        attempts: Number(claimed[0].attempts),
        ...(typeof claimed[0].intent_analysis_id === "string"
          ? { intentAnalysisId: claimed[0].intent_analysis_id }
          : {}),
        ...(typeof claimed[0].source_analysis_id === "string"
          ? { sourceAnalysisId: claimed[0].source_analysis_id }
          : {}),
        ...(claimed[0].intent_phase === "enriched" ? { intentPhase: "enriched" as const } : {}),
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
          .select("id, filename, media_type, byte_size, storage_path, storage_state, observed_media_type, stored_byte_size, sha256, metadata")
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
          ...(typeof jsonObject(asset.metadata).role === "string"
            ? { role: jsonObject(asset.metadata).role as string }
            : {}),
          ...(typeof asset.id === "string" ? {
            id: asset.id, storagePath: requireString(asset, "storage_path"),
            storageState: requireString(asset, "storage_state"),
            observedMediaType: optionalString(asset, "observed_media_type"),
            storedByteSize: typeof asset.stored_byte_size === "number" ? asset.stored_byte_size : null,
            sha256: optionalString(asset, "sha256"),
          } : {}),
          mediaType: optionalString(asset, "media_type"),
          byteSize: typeof asset.byte_size === "number" ? asset.byte_size : null,
        })),
      };
    },

    async loadIntentAnalysis(
      analysisId: string,
      captureId: string,
    ): Promise<StoredIntentAnalysis | undefined> {
      const analyses = rowsFrom(
        await client
          .from("capture_analyses")
          .select(
            "id, capture_id, input_snapshot, result, confidence, model_id, prompt_version, pipeline_version",
          )
          .eq("id", analysisId)
          .eq("capture_id", captureId)
          .eq("analysis_type", "intent")
          .eq("status", "succeeded")
          .limit(1),
        "read the selected intent analysis",
      );

      if (analyses.length === 0) return undefined;
      const analysis = analyses[0];
      const confidence = analysis.confidence;

      if (typeof confidence !== "number") {
        throw new Error("Column confidence is missing from the returned analysis");
      }

      return {
        id: requireString(analysis, "id"),
        captureId: requireString(analysis, "capture_id"),
        inputSnapshot: jsonObject(analysis.input_snapshot),
        result: jsonObject(analysis.result),
        confidence,
        modelId: requireString(analysis, "model_id"),
        promptVersion: requireString(analysis, "prompt_version"),
        pipelineVersion: requireString(analysis, "pipeline_version"),
      };
    },

    async loadSourceAnalysis(
      analysisId: string,
      captureId: string,
    ): Promise<StoredSourceAnalysis | undefined> {
      const analyses = rowsFrom(
        await client
          .from("capture_analyses")
          .select(
            "id, capture_id, input_snapshot, result, confidence, model_id, prompt_version, pipeline_version",
          )
          .eq("id", analysisId)
          .eq("capture_id", captureId)
          .eq("analysis_type", "source_resolution")
          .eq("status", "succeeded")
          .limit(1),
        "read the selected source analysis",
      );
      if (analyses.length === 0) return undefined;
      const analysis = analyses[0];
      if (typeof analysis.confidence !== "number") {
        throw new Error("Column confidence is missing from the returned analysis");
      }
      return {
        id: requireString(analysis, "id"),
        captureId: requireString(analysis, "capture_id"),
        inputSnapshot: jsonObject(analysis.input_snapshot),
        result: jsonObject(analysis.result),
        confidence: analysis.confidence,
        modelId: optionalString(analysis, "model_id"),
        promptVersion: requireString(analysis, "prompt_version"),
        pipelineVersion: requireString(analysis, "pipeline_version"),
      };
    },

    async finishAttempt(job: CaptureJob, record: AnalysisRecordInput | null, errorCode?: string) {
      const rpcName = job.jobType === "source_resolution"
        ? "finish_source_resolution_attempt"
        : job.jobType === "segment_resolution"
          ? "finish_segment_resolution_attempt"
          : "finish_intent_attempt";
      const finished = rowsFrom(
        await client.rpc(rpcName, {
          p_job_id: job.id,
          p_attempt: job.attempts,
          p_record: record,
          p_error_code: errorCode ?? null,
        }),
        "finish the capture attempt",
      );
      if (finished.length === 0) return undefined;
      const resolutionJobId = optionalString(finished[0], "resolution_job_id");
      const segmentJobId = optionalString(finished[0], "segment_job_id");
      return {
        analysisId: optionalString(finished[0], "analysis_id"),
        ...(resolutionJobId === null ? {} : { resolutionJobId }),
        ...(segmentJobId === null ? {} : { segmentJobId }),
      };
    },
  };
}
