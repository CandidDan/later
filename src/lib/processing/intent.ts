import { IntentAnalysisError } from "./errors";
import { IntentResultSchemaError, overallConfidence, type IntentResult } from "./intent-result";
import { PIPELINE_VERSION, PROMPT_VERSION, MEDIA_PIPELINE_VERSION, MEDIA_PROMPT_VERSION } from "./prompt";
import { buildIntentInputSnapshot } from "./intent-input";
import { buildEnrichedIntentInput, type ReadPrivateImage } from "./media-input";
import type { IntentAnalyser } from "./anthropic";
import type { CaptureJobStore, JsonValue } from "../jobs/types";

export type IntentProcessingOutcome =
  | { status: "idle" }
  | {
      status: "succeeded";
      jobId: string;
      captureId: string;
      analysisId: string;
      modelId: string;
      resolutionJobId?: string;
    }
  | { status: "failed"; jobId: string; captureId: string; errorCode: string };

export interface ProcessIntentJobDependencies {
  store: CaptureJobStore;
  analyse: IntentAnalyser;
  readImage?: ReadPrivateImage;
}

/**
 * The recorded failure reason is an allowlisted code, never provider-controlled text.
 * Provider errors and rejected model output can both quote the capture back at us, and a
 * `last_error` column is the least protected place that text could end up.
 */
function classifyFailure(error: unknown): string {
  return error instanceof IntentResultSchemaError
      ? "result_schema_invalid"
      : error instanceof IntentAnalysisError
        ? "provider_response_invalid"
        : "provider_unavailable";
}

/** The validated result as plain JSON, which also proves it is storable without loss. */
function toStorableResult(result: IntentResult): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>;
}

/**
 * Claim one pending `intent_analysis` job, analyse it in shadow mode and append the run.
 *
 * Every path is append-only: a run adds an analysis row, it never edits one. A failure leaves
 * the capture untouched, records the attempt, and returns the job to the queue so the
 * configured retry policy still owns it.
 */
export async function processNextIntentJob({
  store,
  analyse,
  readImage,
}: ProcessIntentJobDependencies): Promise<IntentProcessingOutcome> {
  const job = await store.claimNextJob("intent_analysis");

  if (job === undefined) {
    return { status: "idle" };
  }

  const capture = await store.loadCapture(job.captureId);

  if (capture === undefined) {
    await store.finishAttempt(job, null, "capture_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "capture_missing" };
  }

  let inputSnapshot = buildIntentInputSnapshot(capture);
  const pipelineVersion = job.intentPhase === "enriched" ? MEDIA_PIPELINE_VERSION : PIPELINE_VERSION;
  const promptVersion = job.intentPhase === "enriched" ? MEDIA_PROMPT_VERSION : PROMPT_VERSION;
  let analysis;

  try {
    if (job.intentPhase === "enriched") {
      const enriched = await buildEnrichedIntentInput(capture, readImage ?? (async () => { throw new Error("private_image_reader_missing"); }));
      inputSnapshot = enriched.snapshot;
      analysis = await analyse(inputSnapshot, enriched.images);
    } else {
      analysis = await analyse(inputSnapshot);
    }
  } catch (error) {
    const code = classifyFailure(error);

    await store.finishAttempt(job, {
      captureId: capture.id,
      status: "failed",
      inputSnapshot,
      result: null,
      confidence: null,
      modelId: null,
      promptVersion,
      pipelineVersion,
      errorCode: code,
    }, code);

    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: code };
  }

  const finished = await store.finishAttempt(job, {
    captureId: capture.id,
    status: "succeeded",
    inputSnapshot,
    result: toStorableResult(analysis.result),
    confidence: overallConfidence(analysis.result),
    modelId: analysis.modelId,
    promptVersion,
    pipelineVersion,
    errorCode: null,
  });

  // A recovered/expired lease is no longer authorized to publish a result.
  if (!finished?.analysisId) {
    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: "lease_lost" };
  }
  const { analysisId, resolutionJobId } = finished;

  return {
    status: "succeeded",
    jobId: job.id,
    captureId: capture.id,
    analysisId,
    modelId: analysis.modelId,
    ...(resolutionJobId === undefined ? {} : { resolutionJobId }),
  };
}
