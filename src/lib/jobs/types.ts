import type { JsonValue } from "../capture/persist";

export type { JsonValue };

export type CaptureJobType = "intent_analysis" | "source_resolution" | "media_download";

export interface CaptureJob {
  id: string;
  captureId: string;
  jobType: CaptureJobType;
  attempts: number;
  assetId?: string;
  intentPhase?: "initial" | "enriched";
}

export interface CaptureAssetRecord {
  filename: string;
  mediaType: string | null;
  byteSize: number | null;
  id?: string;
  storagePath?: string;
  storageState?: string;
  observedMediaType?: string | null;
  storedByteSize?: number | null;
  sha256?: string | null;
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
  finishAttempt(
    job: CaptureJob,
    record: AnalysisRecordInput | null,
    errorCode?: string,
  ): Promise<{ analysisId: string | null; resolutionJobId?: string } | undefined>;
}
