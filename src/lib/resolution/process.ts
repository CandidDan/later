import type { JsonValue, SourceResolutionJobStore } from "../jobs/types";
import {
  SOURCE_PIPELINE_VERSION,
  SOURCE_PROMPT_VERSION,
  SourceResolutionAnalysisError,
  type SourceResolutionAnalyser,
} from "./protocol";
import { buildSourceResolutionInputSnapshot, type PublicMetadata } from "./input";
import { fetchPublicMetadata, MetadataError } from "./metadata";
import { recognizeSource } from "./recognized";
import {
  parseSourceResolutionResult,
  SourceResolutionResultSchemaError,
  type SourceEvidence,
  type SourceResolutionResult,
} from "./result";

export const DIRECT_SOURCE_PROMPT_VERSION = "source-direct-v0.1";

export type SourceResolutionOutcome =
  | { status: "idle" }
  | {
      status: "succeeded";
      jobId: string;
      captureId: string;
      analysisId: string;
      modelId: string | null;
      segmentJobId?: string;
    }
  | { status: "failed"; jobId: string; captureId: string; errorCode: string };

export interface ProcessSourceResolutionDependencies {
  store: SourceResolutionJobStore;
  analyse: SourceResolutionAnalyser;
  fetchMetadata?: (url: string) => Promise<PublicMetadata>;
}

function jsonResult(result: SourceResolutionResult): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>;
}

function evidenceIds(
  evidence: readonly SourceEvidence[],
  selections: ReadonlyArray<{ kinds: readonly SourceEvidence["kind"][]; value: string }>,
): string[] {
  return selections.map(({ kinds, value }) => {
    const item = evidence.find((candidate) => kinds.includes(candidate.kind) && candidate.value === value);
    if (!item) throw new SourceResolutionResultSchemaError("deterministic result lacks snapshot evidence");
    return item.id;
  });
}

function directResult(
  metadata: PublicMetadata,
  sourceType: NonNullable<SourceResolutionResult["sourceType"]>,
  evidence: readonly SourceEvidence[],
): SourceResolutionResult | undefined {
  if (!metadata.title || !metadata.creator || !metadata.canonicalUrl) return undefined;
  const selections: Array<{ kinds: readonly SourceEvidence["kind"][]; value: string }> = [
    { kinds: ["metadata_title"], value: metadata.title },
    { kinds: ["metadata_creator"], value: metadata.creator },
    { kinds: ["captured_url", "metadata_canonical_url"], value: metadata.canonicalUrl },
  ];
  if (metadata.durationSeconds !== undefined) {
    selections.push({ kinds: ["metadata_duration"], value: String(metadata.durationSeconds) });
  }
  if (metadata.transcriptUrl !== undefined) {
    selections.push({ kinds: ["metadata_transcript_url"], value: metadata.transcriptUrl });
  }
  return parseSourceResolutionResult({
    status: "resolved",
    sourceType,
    title: metadata.title,
    creator: metadata.creator,
    canonicalUrl: metadata.canonicalUrl,
    durationSeconds: metadata.durationSeconds ?? null,
    transcriptUrl: metadata.transcriptUrl ?? null,
    confidence: 1,
    evidence: evidenceIds(evidence, selections),
  }, evidence);
}

function unresolved(evidence: readonly SourceEvidence[]): SourceResolutionResult {
  return parseSourceResolutionResult({
    status: "unresolved",
    sourceType: null,
    title: null,
    creator: null,
    canonicalUrl: null,
    durationSeconds: null,
    transcriptUrl: null,
    confidence: 0,
    evidence: [evidence[0].id],
  }, evidence);
}

function failureCode(error: unknown): string {
  if (error instanceof SourceResolutionResultSchemaError) return "result_schema_invalid";
  if (error instanceof SourceResolutionAnalysisError) return "provider_response_invalid";
  if (error instanceof MetadataError && error.code === "metadata_unavailable") return "metadata_unavailable";
  return "provider_unavailable";
}

/** Claim and independently process one source-resolution job. */
export async function processNextSourceResolutionJob({
  store,
  analyse,
  fetchMetadata: metadataFetcher = fetchPublicMetadata,
}: ProcessSourceResolutionDependencies): Promise<SourceResolutionOutcome> {
  const job = await store.claimNextJob("source_resolution");
  if (!job) return { status: "idle" };
  const capture = await store.loadCapture(job.captureId);
  if (!capture) {
    await store.finishAttempt(job, null, "capture_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "capture_missing" };
  }
  if (!job.intentAnalysisId) {
    await store.finishAttempt(job, null, "intent_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "intent_missing" };
  }
  const intent = await store.loadIntentAnalysis(job.intentAnalysisId, job.captureId);
  if (!intent) {
    await store.finishAttempt(job, null, "intent_missing");
    return { status: "failed", jobId: job.id, captureId: job.captureId, errorCode: "intent_missing" };
  }

  const captureUrls = (buildSourceResolutionInputSnapshot(capture, intent, []).snapshot.capture.urls ?? []) as JsonValue[];
  const urls = captureUrls.filter((url): url is string => typeof url === "string").slice(0, 3);
  const recognized = urls.map(recognizeSource).find((source) => source !== undefined);
  const destinations = recognized ? [recognized.canonicalUrl] : [...new Set(urls)];
  const metadata: PublicMetadata[] = [];
  const notices: string[] = [];

  try {
    for (const destination of destinations) {
      try {
        const item = await metadataFetcher(destination);
        metadata.push(recognized && destination === recognized.canonicalUrl
          ? { ...item, canonicalUrl: recognized.canonicalUrl }
          : item);
      } catch (error) {
        if (error instanceof MetadataError && error.code !== "metadata_unavailable") {
          notices.push(error.code);
          continue;
        }
        throw error;
      }
    }

    if (metadata.length === 0 && notices.length === 0) notices.push("insufficient_evidence");
    const built = buildSourceResolutionInputSnapshot(capture, intent, metadata, notices);
    let result: SourceResolutionResult;
    let modelId: string | null = null;
    let promptVersion = DIRECT_SOURCE_PROMPT_VERSION;

    const deterministic = recognized && metadata[0]
      ? directResult(metadata[0], recognized.sourceType, built.evidence)
      : undefined;
    if (deterministic) {
      result = deterministic;
    } else if (metadata.length > 0) {
      const analysis = await analyse(built.snapshot, built.evidence);
      result = analysis.result;
      modelId = analysis.modelId;
      promptVersion = SOURCE_PROMPT_VERSION;
    } else {
      result = unresolved(built.evidence);
    }

    const finished = await store.finishAttempt(job, {
      captureId: capture.id,
      status: "succeeded",
      inputSnapshot: built.snapshot,
      result: jsonResult(result),
      confidence: result.confidence,
      modelId,
      promptVersion,
      pipelineVersion: SOURCE_PIPELINE_VERSION,
      errorCode: null,
    });
    if (!finished?.analysisId) {
      return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: "lease_lost" };
    }
    return {
      status: "succeeded",
      jobId: job.id,
      captureId: capture.id,
      analysisId: finished.analysisId,
      modelId,
      ...(finished.segmentJobId === undefined ? {} : { segmentJobId: finished.segmentJobId }),
    };
  } catch (error) {
    const code = failureCode(error);
    const built = buildSourceResolutionInputSnapshot(capture, intent, metadata, notices);
    await store.finishAttempt(job, {
      captureId: capture.id,
      status: "failed",
      inputSnapshot: built.snapshot,
      result: null,
      confidence: null,
      modelId: null,
      promptVersion: SOURCE_PROMPT_VERSION,
      pipelineVersion: SOURCE_PIPELINE_VERSION,
      errorCode: code,
    }, code);
    return { status: "failed", jobId: job.id, captureId: capture.id, errorCode: code };
  }
}
