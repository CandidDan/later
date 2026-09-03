import type { JsonValue } from "../capture/persist";

export type { JsonValue };

export type CaptureJobType = "intent_analysis" | "source_resolution";

export interface CaptureJob {
  id: string;
  captureId: string;
  jobType: CaptureJobType;
  attempts: number;
}

export interface CaptureAssetRecord {
  filename: string;
  mediaType: string | null;
  byteSize: number | null;
}

/**
 * The capture exactly as it was written at capture time. Nothing on this record is derived
 * from later evaluation or resolution — that is what makes it safe to feed to the model as
 * the sole basis for an intent run.
 */
export interface CaptureRecord {
  id: string;
  channel: string;
  captureKind: string;
  rawText: string | null;
  userNote: string | null;
  sourcePlatform: string | null;
  capturedAt: string;
  rawPayload: Record<string, JsonValue>;
  assets: readonly CaptureAssetRecord[];
}

export interface AnalysisRecordInput {
  captureId: string;
  status: "succeeded" | "failed";
  inputSnapshot: Record<string, JsonValue>;
  result: Record<string, JsonValue> | null;
  confidence: number | null;
  modelId: string | null;
  promptVersion: string;
  pipelineVersion: string;
  errorCode: string | null;
}

/**
 * Every database interaction intent processing needs, named as operations rather than as
 * queries so the processor can be exercised without a database.
 */
export interface CaptureJobStore {
  claimNextJob(jobType: CaptureJobType): Promise<CaptureJob | undefined>;
  loadCapture(captureId: string): Promise<CaptureRecord | undefined>;
  appendAnalysis(record: AnalysisRecordInput): Promise<string>;
  completeJob(jobId: string): Promise<void>;
  releaseJob(jobId: string, errorMessage: string): Promise<void>;
  countPendingJobs(captureId: string, jobType: CaptureJobType): Promise<number>;
  enqueueJob(captureId: string, jobType: CaptureJobType): Promise<string>;
}
