import { buildIntentInputSnapshot } from "../processing/intent-input";
import type {
  CaptureRecord,
  JsonValue,
  StoredIntentAnalysis,
} from "../jobs/types";
import type { SourceEvidence } from "./result";

export interface PublicMetadata {
  requestedUrl: string;
  finalUrl: string;
  contentType: "text/html" | "application/json" | "application/ld+json";
  title?: string;
  creator?: string;
  canonicalUrl?: string;
  durationSeconds?: number;
  transcriptUrl?: string;
}
export interface SourceResolutionInputSnapshot extends Record<string, JsonValue> {
  capture: Record<string, JsonValue>;
  intentAnalysis: Record<string, JsonValue>;
  publicMetadata: Array<Record<string, JsonValue>>;
  evidence: Array<Record<string, JsonValue>>;
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function hintsFrom(intent: StoredIntentAnalysis): string[] {
  const source = intent.result.underlyingSource;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return [];
  const hints = (source as Record<string, JsonValue>).hints;
  return Array.isArray(hints)
    ? hints.filter((hint): hint is string => typeof hint === "string" && hint.trim().length > 0)
    : [];
}

function metadataRecord(metadata: PublicMetadata): Record<string, JsonValue> {
  return {
    requestedUrl: metadata.requestedUrl,
    finalUrl: metadata.finalUrl,
    contentType: metadata.contentType,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
    ...(metadata.canonicalUrl === undefined ? {} : { canonicalUrl: metadata.canonicalUrl }),
    ...(metadata.durationSeconds === undefined ? {} : { durationSeconds: metadata.durationSeconds }),
    ...(metadata.transcriptUrl === undefined ? {} : { transcriptUrl: metadata.transcriptUrl }),
  };
}

/** Build the exact, immutable evidence boundary used by direct and model-assisted resolution. */
export function buildSourceResolutionInputSnapshot(
  capture: CaptureRecord,
  intent: StoredIntentAnalysis,
  metadata: readonly PublicMetadata[],
  notices: readonly string[] = [],
): { snapshot: SourceResolutionInputSnapshot; evidence: SourceEvidence[] } {
  const captureSnapshot = buildIntentInputSnapshot(capture);
  const evidence: SourceEvidence[] = captureSnapshot.urls.map((url, index) => ({
    id: `capture.url.${index}`,
    kind: "captured_url",
    value: url,
  }));

  for (const [index, hint] of hintsFrom(intent).entries()) {
    evidence.push({ id: `intent.hint.${index}`, kind: "intent_hint", value: hint });
  }
  for (const [index, item] of metadata.entries()) {
    const fields = [
      ["title", "metadata_title", item.title],
      ["creator", "metadata_creator", item.creator],
      ["canonicalUrl", "metadata_canonical_url", item.canonicalUrl],
      ["durationSeconds", "metadata_duration", item.durationSeconds?.toString()],
      ["transcriptUrl", "metadata_transcript_url", item.transcriptUrl],
    ] as const;
    for (const [field, kind, value] of fields) {
      if (value !== undefined) {
        evidence.push({ id: `metadata.${index}.${field}`, kind, value });
      }
    }
  }
  for (const [index, notice] of notices.entries()) {
    evidence.push({ id: `resolution.notice.${index}`, kind: "resolution_notice", value: notice });
  }

  return {
    snapshot: {
      capture: jsonRecord(captureSnapshot),
      intentAnalysis: {
        id: intent.id,
        captureId: intent.captureId,
        inputSnapshot: jsonRecord(intent.inputSnapshot),
        result: jsonRecord(intent.result),
        confidence: intent.confidence,
        modelId: intent.modelId,
        promptVersion: intent.promptVersion,
        pipelineVersion: intent.pipelineVersion,
      },
      publicMetadata: metadata.map(metadataRecord),
      evidence: evidence.map((entry) => ({ ...entry })),
    },
    evidence,
  };
}
