export const SOURCE_TYPES = [
  "youtube_video",
  "spotify_episode",
  "spotify_show",
  "podcast_episode",
  "article",
  "other",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_EVIDENCE_KINDS = [
  "captured_url",
  "metadata_title",
  "metadata_creator",
  "metadata_canonical_url",
  "metadata_duration",
  "metadata_transcript_url",
  "intent_hint",
  "resolution_notice",
] as const;

export type SourceEvidenceKind = (typeof SOURCE_EVIDENCE_KINDS)[number];

export interface SourceEvidence {
  id: string;
  kind: SourceEvidenceKind;
  value: string;
}
interface ResolutionBase {
  confidence: number;
  /** IDs of evidence stored in the immutable input snapshot. */
  evidence: string[];
}

export interface ResolvedSourceResult extends ResolutionBase {
  status: "resolved";
  sourceType: SourceType;
  title: string;
  creator: string;
  canonicalUrl: string;
  durationSeconds: number | null;
  transcriptUrl: string | null;
}

export interface UnresolvedSourceResult extends ResolutionBase {
  status: "unresolved";
  sourceType: null;
  title: null;
  creator: null;
  canonicalUrl: null;
  durationSeconds: null;
  transcriptUrl: null;
}

export type SourceResolutionResult = ResolvedSourceResult | UnresolvedSourceResult;

export class SourceResolutionResultSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceResolutionResultSchemaError";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceResolutionResultSchemaError("result must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const expected = [
    "canonicalUrl",
    "confidence",
    "creator",
    "durationSeconds",
    "evidence",
    "sourceType",
    "status",
    "title",
    "transcriptUrl",
  ];
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SourceResolutionResultSchemaError("result fields do not match the source schema");
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SourceResolutionResultSchemaError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function selectedEvidence(
  value: unknown,
  evidence: readonly SourceEvidence[],
): SourceEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SourceResolutionResultSchemaError("evidence must contain at least one snapshot id");
  }
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  const ids = value.map((entry) => nonEmptyString(entry, "evidence id"));
  if (new Set(ids).size !== ids.length) {
    throw new SourceResolutionResultSchemaError("evidence ids must be unique");
  }
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) {
      throw new SourceResolutionResultSchemaError("evidence must cite only the immutable input snapshot");
    }
    return item;
  });
}

function hasEvidence(
  selected: readonly SourceEvidence[],
  kinds: readonly SourceEvidenceKind[],
  value: string,
): boolean {
  return selected.some((entry) => kinds.includes(entry.kind) && entry.value === value);
}

/**
 * Validate model or deterministic output against the exact evidence snapshot. Identity fields
 * cannot be invented: each must equal a selected evidence value of the corresponding kind.
 */
export function parseSourceResolutionResult(
  input: unknown,
  evidence: readonly SourceEvidence[],
): SourceResolutionResult {
  const value = objectValue(input);
  exactKeys(value);
  const selected = selectedEvidence(value.evidence, evidence);
  const selectedIds = selected.map((entry) => entry.id);
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new SourceResolutionResultSchemaError("confidence must be between zero and one");
  }

  if (value.status === "unresolved") {
    for (const field of ["sourceType", "title", "creator", "canonicalUrl", "durationSeconds", "transcriptUrl"] as const) {
      if (value[field] !== null) {
        throw new SourceResolutionResultSchemaError(`unresolved ${field} must be null`);
      }
    }
    return {
      status: "unresolved",
      sourceType: null,
      title: null,
      creator: null,
      canonicalUrl: null,
      durationSeconds: null,
      transcriptUrl: null,
      confidence,
      evidence: selectedIds,
    };
  }

  if (value.status !== "resolved" || !SOURCE_TYPES.includes(value.sourceType as SourceType)) {
    throw new SourceResolutionResultSchemaError("status or sourceType is invalid");
  }
  const title = nonEmptyString(value.title, "title");
  const creator = nonEmptyString(value.creator, "creator");
  const canonicalUrl = nonEmptyString(value.canonicalUrl, "canonicalUrl");
  const transcriptUrl = value.transcriptUrl === null
    ? null
    : nonEmptyString(value.transcriptUrl, "transcriptUrl");
  const durationSeconds = value.durationSeconds;
  if (durationSeconds !== null && (
    typeof durationSeconds !== "number" || !Number.isInteger(durationSeconds) || durationSeconds <= 0
  )) {
    throw new SourceResolutionResultSchemaError("durationSeconds must be a positive integer or null");
  }
  if (!hasEvidence(selected, ["metadata_title"], title)
      || !hasEvidence(selected, ["metadata_creator"], creator)
      || !hasEvidence(selected, ["captured_url", "metadata_canonical_url"], canonicalUrl)) {
    throw new SourceResolutionResultSchemaError("resolved identity must match selected snapshot evidence");
  }
  if (transcriptUrl !== null && !hasEvidence(selected, ["metadata_transcript_url"], transcriptUrl)) {
    throw new SourceResolutionResultSchemaError("transcriptUrl must match selected snapshot evidence");
  }
  if (durationSeconds !== null && !hasEvidence(selected, ["metadata_duration"], String(durationSeconds))) {
    throw new SourceResolutionResultSchemaError("durationSeconds must match selected snapshot evidence");
  }

  return {
    status: "resolved",
    sourceType: value.sourceType as SourceType,
    title,
    creator,
    canonicalUrl,
    durationSeconds,
    transcriptUrl,
    confidence,
    evidence: selectedIds,
  };
}
