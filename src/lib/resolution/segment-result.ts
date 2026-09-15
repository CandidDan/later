import type {
  SegmentEvidence,
  SegmentMaterial,
  SegmentRepresentation,
  TextSegmentEvidence,
  TimedSegmentEvidence,
} from "./segment-material";

interface SegmentResultBase {
  confidence: number;
  evidence: string[];
}

export interface ResolvedSegmentResult extends SegmentResultBase {
  status: "resolved";
  representation: SegmentRepresentation;
  startSeconds: number | null;
  endSeconds: number | null;
  sectionStart: number | null;
  sectionEnd: number | null;
  excerpt: string;
  label: string | null;
}

export interface UnresolvedSegmentResult extends SegmentResultBase {
  status: "unresolved";
  representation: null;
  startSeconds: null;
  endSeconds: null;
  sectionStart: null;
  sectionEnd: null;
  excerpt: null;
  label: null;
}

export type SegmentResolutionResult = ResolvedSegmentResult | UnresolvedSegmentResult;

export class SegmentResolutionResultSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentResolutionResultSchemaError";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SegmentResolutionResultSchemaError("result must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const expected = [
    "confidence", "endSeconds", "evidence", "excerpt", "label", "representation",
    "sectionEnd", "sectionStart", "startSeconds", "status",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new SegmentResolutionResultSchemaError("result fields do not match the segment schema");
  }
}

function confidenceValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new SegmentResolutionResultSchemaError("confidence must be between zero and one");
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SegmentResolutionResultSchemaError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function selectedEvidence(value: unknown, evidence: readonly SegmentEvidence[]): SegmentEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SegmentResolutionResultSchemaError("evidence must contain at least one snapshot id");
  }
  const ids = value.map((item) => nonEmptyString(item, "evidence id"));
  if (new Set(ids).size !== ids.length) {
    throw new SegmentResolutionResultSchemaError("evidence ids must be unique");
  }
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new SegmentResolutionResultSchemaError("evidence must cite only the immutable input snapshot");
    return item;
  });
}

function nullResolvedFields(value: Record<string, unknown>): void {
  for (const field of [
    "representation", "startSeconds", "endSeconds", "sectionStart", "sectionEnd", "excerpt", "label",
  ] as const) {
    if (value[field] !== null) {
      throw new SegmentResolutionResultSchemaError(`unresolved ${field} must be null`);
    }
  }
}

function optionalLabel(value: unknown, content: string): string | null {
  if (value === null) return null;
  const label = nonEmptyString(value, "label");
  if (!content.includes(label)) {
    throw new SegmentResolutionResultSchemaError("label must occur in the supplied source material");
  }
  return label;
}

function timedResult(
  value: Record<string, unknown>,
  selected: readonly SegmentEvidence[],
  material: SegmentMaterial,
  base: SegmentResultBase,
  excerpt: string,
  label: string | null,
): ResolvedSegmentResult {
  if (value.sectionStart !== null || value.sectionEnd !== null) {
    throw new SegmentResolutionResultSchemaError("timed results cannot contain text section boundaries");
  }
  const startSeconds = value.startSeconds;
  const endSeconds = value.endSeconds;
  if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0
      || typeof endSeconds !== "number" || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    throw new SegmentResolutionResultSchemaError("timestamps must be non-negative and ordered");
  }
  const timed = selected.filter((item): item is TimedSegmentEvidence => item.kind === "timed");
  if (timed.length === 0) throw new SegmentResolutionResultSchemaError("timed result requires timed evidence");
  const evidenceStart = Math.min(...timed.map((item) => item.startSeconds));
  const evidenceEnd = Math.max(...timed.map((item) => item.endSeconds));
  const knownDuration = material.durationSeconds ?? Math.max(...material.evidence
    .filter((item): item is TimedSegmentEvidence => item.kind === "timed")
    .map((item) => item.endSeconds));
  if (startSeconds < evidenceStart || endSeconds > evidenceEnd || endSeconds > knownDuration) {
    throw new SegmentResolutionResultSchemaError("timestamps must stay within cited evidence and source duration");
  }
  if (!timed.some((item) => item.text.includes(excerpt))) {
    throw new SegmentResolutionResultSchemaError("excerpt must occur in cited timed evidence");
  }
  return {
    status: "resolved", representation: "timed", startSeconds, endSeconds,
    sectionStart: null, sectionEnd: null, excerpt, label, ...base,
  };
}

function textResult(
  value: Record<string, unknown>,
  selected: readonly SegmentEvidence[],
  material: SegmentMaterial,
  base: SegmentResultBase,
  excerpt: string,
  label: string | null,
): ResolvedSegmentResult {
  if (value.startSeconds !== null || value.endSeconds !== null) {
    throw new SegmentResolutionResultSchemaError("text results cannot fabricate timestamps");
  }
  const text = selected.filter((item): item is TextSegmentEvidence => item.kind === "text");
  if (text.length === 0) throw new SegmentResolutionResultSchemaError("text result requires text evidence");
  let sectionStart: number | null = null;
  let sectionEnd: number | null = null;
  if (value.sectionStart !== null || value.sectionEnd !== null) {
    if (!Number.isInteger(value.sectionStart) || !Number.isInteger(value.sectionEnd)) {
      throw new SegmentResolutionResultSchemaError("text section boundaries must be integer character offsets");
    }
    sectionStart = value.sectionStart as number;
    sectionEnd = value.sectionEnd as number;
    if (sectionStart < 0 || sectionEnd <= sectionStart || sectionEnd > material.content.length
        || !material.content.slice(sectionStart, sectionEnd).includes(excerpt)) {
      throw new SegmentResolutionResultSchemaError("text section boundaries must contain the excerpt in source material");
    }
  }
  if (!material.content.includes(excerpt) || !text.some((item) => item.text.includes(excerpt))) {
    throw new SegmentResolutionResultSchemaError("excerpt must occur in cited text evidence");
  }
  return {
    status: "resolved", representation: "text", startSeconds: null, endSeconds: null,
    sectionStart, sectionEnd, excerpt, label, ...base,
  };
}

/** Validate a segment result against the exact fetched material and evidence snapshot. */
export function parseSegmentResolutionResult(
  input: unknown,
  material: SegmentMaterial | null,
  evidence: readonly SegmentEvidence[],
): SegmentResolutionResult {
  const value = objectValue(input);
  exactKeys(value);
  const selected = selectedEvidence(value.evidence, evidence);
  const base = {
    confidence: confidenceValue(value.confidence),
    evidence: selected.map((item) => item.id),
  };

  if (value.status === "unresolved") {
    nullResolvedFields(value);
    return { status: "unresolved", representation: null, startSeconds: null, endSeconds: null,
      sectionStart: null, sectionEnd: null, excerpt: null, label: null, ...base };
  }
  if (value.status !== "resolved" || !material || value.representation !== material.representation) {
    throw new SegmentResolutionResultSchemaError("resolved status or representation is invalid");
  }
  const excerpt = nonEmptyString(value.excerpt, "excerpt");
  const label = optionalLabel(value.label, material.content);
  return material.representation === "timed"
    ? timedResult(value, selected, material, base, excerpt, label)
    : textResult(value, selected, material, base, excerpt, label);
}

export function unresolvedSegmentResult(evidence: readonly SegmentEvidence[]): UnresolvedSegmentResult {
  return parseSegmentResolutionResult({
    status: "unresolved", representation: null, startSeconds: null, endSeconds: null,
    sectionStart: null, sectionEnd: null, excerpt: null, label: null, confidence: 0,
    evidence: [evidence[0].id],
  }, null, evidence) as UnresolvedSegmentResult;
}
