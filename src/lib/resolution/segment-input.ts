import type { CaptureJob, JsonValue, StoredSourceAnalysis } from "../jobs/types";
import type { SegmentEvidence, SegmentMaterial } from "./segment-material";

export interface SegmentResolutionInputSnapshot extends Record<string, JsonValue> {
  segmentJob: Record<string, JsonValue>;
  sourceAnalysis: Record<string, JsonValue>;
  frozenInterest: JsonValue;
  sourceMaterial: Record<string, JsonValue> | null;
  evidence: Array<Record<string, JsonValue>>;
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function frozenInterest(source: StoredSourceAnalysis): JsonValue {
  const intent = source.inputSnapshot.intentAnalysis;
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return null;
  const result = (intent as Record<string, JsonValue>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  return (result as Record<string, JsonValue>).interest ?? null;
}

/** Freeze the exact source analysis, captured interest, material identity/digest and model evidence. */
export function buildSegmentResolutionInputSnapshot(
  job: CaptureJob,
  source: StoredSourceAnalysis,
  material: SegmentMaterial | null,
  notices: readonly string[] = [],
): { snapshot: SegmentResolutionInputSnapshot; evidence: SegmentEvidence[] } {
  const evidence: SegmentEvidence[] = material
    ? material.evidence.map((item) => ({ ...item }))
    : [];
  for (const [index, value] of notices.entries()) {
    evidence.push({ id: `segment.notice.${index}`, kind: "notice", value });
  }
  const materialSnapshot = material ? {
    requestedUrl: material.requestedUrl,
    finalUrl: material.finalUrl,
    contentType: material.contentType,
    sha256: material.sha256,
    byteLength: material.byteLength,
    representation: material.representation,
    durationSeconds: material.durationSeconds,
  } : null;
  return {
    snapshot: {
      segmentJob: { id: job.id, attempt: job.attempts },
      sourceAnalysis: {
        id: source.id,
        captureId: source.captureId,
        inputSnapshot: jsonRecord(source.inputSnapshot),
        result: jsonRecord(source.result),
        confidence: source.confidence,
        modelId: source.modelId,
        promptVersion: source.promptVersion,
        pipelineVersion: source.pipelineVersion,
      },
      frozenInterest: frozenInterest(source),
      sourceMaterial: materialSnapshot,
      evidence: evidence.map((item) => jsonRecord(item)),
    },
    evidence,
  };
}
