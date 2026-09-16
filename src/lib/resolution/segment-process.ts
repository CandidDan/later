import type {
  JsonValue,
  SegmentResolutionJobStore,
  StoredSourceAnalysis,
} from "../jobs/types";
import { MetadataError } from "./metadata";
import { buildSegmentResolutionInputSnapshot } from "./segment-input";
import { fetchSegmentMaterial, type SegmentMaterial } from "./segment-material";
import {
  SEGMENT_PIPELINE_VERSION,
  SEGMENT_PROMPT_VERSION,
  SegmentResolutionAnalysisError,
  type SegmentResolutionAnalyser,
} from "./segment-protocol";
import {
  SegmentResolutionResultSchemaError,
  unresolvedSegmentResult,
  type SegmentResolutionResult,
} from "./segment-result";

export const UNAVAILABLE_SEGMENT_PROMPT_VERSION = "segment-unavailable-v0.1";

export type SegmentResolutionOutcome =
  | { status: "idle" }
  | {
      status: "succeeded";
      jobId: string;
      captureId: string;
      analysisId: string;
      modelId: string | null;
    }
  | { status: "failed"; jobId: string; captureId: string; errorCode: string };

export interface ProcessSegmentResolutionDependencies {
  store: SegmentResolutionJobStore;
  analyse: SegmentResolutionAnalyser;
  fetchMaterial?: (url: string, durationSeconds: number | null) => Promise<SegmentMaterial>;
}

function jsonResult(result: SegmentResolutionResult): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>;
}

function sourceLocation(source: StoredSourceAnalysis): { transcriptUrl: string; durationSeconds: number | null } | undefined {
  if (source.result.status !== "resolved" || typeof source.result.transcriptUrl !== "string"
      || source.result.transcriptUrl.trim().length === 0) return undefined;
  const duration = source.result.durationSeconds;
  if (duration !== null && (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0)) {
    throw new SegmentResolutionResultSchemaError("source duration is invalid");
  }
  return { transcriptUrl: source.result.transcriptUrl, durationSeconds: duration as number | null };
}

function failureCode(error: unknown): string {
  if (error instanceof SegmentResolutionResultSchemaError) return "result_schema_invalid";
  if (error instanceof SegmentResolutionAnalysisError) return "provider_response_invalid";
  if (error instanceof MetadataError && error.code === "metadata_unavailable") return "segment_unavailable";
  return "provider_unavailable";
}

function honestUnavailable(error: unknown): string | undefined {
  if (!(error instanceof MetadataError)) return undefined;
  return error.code === "unsafe_url" || error.code === "unsafe_redirect"
      || error.code === "metadata_unsupported" || error.code === "metadata_too_large"
    ? error.code
    : undefined;
}

/** Claim and independently process one segment-resolution job. */
export async function processNextSegmentResolutionJob({
  store,
  analyse,
  fetchMaterial: materialFetcher = fetchSegmentMaterial,
}: ProcessSegmentResolutionDependencies): Promise<SegmentResolutionOutcome> {
  const job = await store.claimNextJob("segment_resolution");
  if (!job) return { status: "idle" };
  const capture = await store.loadCapture(job.captureId);
  if (!capture) {
    await store.finishAttempt(job, null, "capture_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "capture_missing" };
  }
  if (!job.sourceAnalysisId) {
    await store.finishAttempt(job, null, "source_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "source_missing" };
  }
  const source = await store.loadSourceAnalysis(job.sourceAnalysisId, job.captureId);
  if (!source) {
    await store.finishAttempt(job, null, "source_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "source_missing" };
  }

  let location: ReturnType<typeof sourceLocation>;
  try {
    location = sourceLocation(source);
  } catch (error) {
    const code = failureCode(error);
    await store.finishAttempt(job, null, code);
    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: code };
  }
  if (!location) {
    const built = buildSegmentResolutionInputSnapshot(job, source, null, ["source_material_absent"]);
    const result = unresolvedSegmentResult(built.evidence);
    const finished = await store.finishAttempt(job, {
      captureId: capture.id,
      status: "succeeded",
      inputSnapshot: built.snapshot,
      result: jsonResult(result),
      confidence: result.confidence,
      modelId: null,
      promptVersion: UNAVAILABLE_SEGMENT_PROMPT_VERSION,
      pipelineVersion: SEGMENT_PIPELINE_VERSION,
      errorCode: null,
    });
    if (!finished?.analysisId) {
      return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: "lease_lost" };
    }
    return { status: "succeeded", jobId: job.id, captureId: capture.id,
      analysisId: finished.analysisId, modelId: null };
  }

  let material: SegmentMaterial | null = null;
  try {
    try {
      material = await materialFetcher(location.transcriptUrl, location.durationSeconds);
    } catch (error) {
      const notice = honestUnavailable(error);
      if (!notice) throw error;
      const built = buildSegmentResolutionInputSnapshot(job, source, null, [notice]);
      const result = unresolvedSegmentResult(built.evidence);
      const finished = await store.finishAttempt(job, {
        captureId: capture.id,
        status: "succeeded",
        inputSnapshot: built.snapshot,
        result: jsonResult(result),
        confidence: result.confidence,
        modelId: null,
        promptVersion: UNAVAILABLE_SEGMENT_PROMPT_VERSION,
        pipelineVersion: SEGMENT_PIPELINE_VERSION,
        errorCode: null,
      });
      if (!finished?.analysisId) {
        return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: "lease_lost" };
      }
      return { status: "succeeded", jobId: job.id, captureId: capture.id,
        analysisId: finished.analysisId, modelId: null };
    }

    const built = buildSegmentResolutionInputSnapshot(job, source, material);
    const analysed = await analyse(built.snapshot, material, built.evidence);
    const finished = await store.finishAttempt(job, {
      captureId: capture.id,
      status: "succeeded",
      inputSnapshot: built.snapshot,
      result: jsonResult(analysed.result),
      confidence: analysed.result.confidence,
      modelId: analysed.modelId,
      promptVersion: SEGMENT_PROMPT_VERSION,
      pipelineVersion: SEGMENT_PIPELINE_VERSION,
      errorCode: null,
    });
    if (!finished?.analysisId) {
      return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: "lease_lost" };
    }
    return { status: "succeeded", jobId: job.id, captureId: capture.id,
      analysisId: finished.analysisId, modelId: analysed.modelId };
  } catch (error) {
    const code = failureCode(error);
    const built = buildSegmentResolutionInputSnapshot(job, source, material);
    await store.finishAttempt(job, {
      captureId: capture.id,
      status: "failed",
      inputSnapshot: built.snapshot,
      result: null,
      confidence: null,
      modelId: null,
      promptVersion: SEGMENT_PROMPT_VERSION,
      pipelineVersion: SEGMENT_PIPELINE_VERSION,
      errorCode: code,
    }, code);
    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: code };
  }
}
