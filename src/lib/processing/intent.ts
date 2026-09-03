import { IntentAnalysisError } from "./errors";
import { IntentResultSchemaError, overallConfidence, type IntentResult } from "./intent-result";
import { PIPELINE_VERSION, PROMPT_VERSION } from "./prompt";
import { buildIntentInputSnapshot } from "./intent-input";
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
}

/**
 * The recorded failure reason is a code plus the failing error's class, never its message.
 * Provider errors and rejected model output can both quote the capture back at us, and a
 * `last_error` column is the least protected place that text could end up.
 */
function classifyFailure(error: unknown): { code: string; detail: string } {
  const code =
    error instanceof IntentResultSchemaError
      ? "result_schema_invalid"
      : error instanceof IntentAnalysisError
        ? "provider_response_invalid"
        : "provider_unavailable";
  const status = (error as { status?: unknown } | null)?.status;
  const name = error instanceof Error ? error.name : "UnknownError";

  return {
    code,
    detail: typeof status === "number" ? `${code} (${name}, HTTP ${status})` : `${code} (${name})`,
  };
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
}: ProcessIntentJobDependencies): Promise<IntentProcessingOutcome> {
  const job = await store.claimNextJob("intent_analysis");

  if (job === undefined) {
    return { status: "idle" };
  }

  const capture = await store.loadCapture(job.captureId);

  if (capture === undefined) {
    await store.releaseJob(job.id, "capture_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "capture_missing" };
  }

  const inputSnapshot = buildIntentInputSnapshot(capture);
  let analysis;

  try {
    analysis = await analyse(inputSnapshot);
  } catch (error) {
    const { code, detail } = classifyFailure(error);

    await store.appendAnalysis({
      captureId: capture.id,
      status: "failed",
      inputSnapshot,
      result: null,
      confidence: null,
      modelId: null,
      promptVersion: PROMPT_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      errorCode: code,
    });
    await store.releaseJob(job.id, detail);

    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: code };
  }

  const analysisId = await store.appendAnalysis({
    captureId: capture.id,
    status: "succeeded",
    inputSnapshot,
    result: toStorableResult(analysis.result),
    confidence: overallConfidence(analysis.result),
    modelId: analysis.modelId,
    promptVersion: PROMPT_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    errorCode: null,
  });

  let resolutionJobId: string | undefined;

  if (analysis.result.resolutionRequired) {
    const pending = await store.countPendingJobs(capture.id, "source_resolution");

    if (pending === 0) {
      resolutionJobId = await store.enqueueJob(capture.id, "source_resolution");
    }
  }

  await store.completeJob(job.id);

  return {
    status: "succeeded",
    jobId: job.id,
    captureId: capture.id,
    analysisId,
    modelId: analysis.modelId,
    ...(resolutionJobId === undefined ? {} : { resolutionJobId }),
  };
}
