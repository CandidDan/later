/**
 * The strict v0 intent result. Every field is validated at runtime before an analysis is
 * stored: the model's output is experimental evidence, so a shape we cannot vouch for is a
 * failed run, never a partially-trusted success.
 */

export const CONTENT_TYPES = [
  "article",
  "video",
  "audio",
  "image",
  "product",
  "recipe",
  "event",
  "place",
  "person",
  "document",
  "post",
  "other",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export const INTEREST_CLASSIFICATIONS = ["atomic", "reference", "uncertain"] as const;

export type InterestClassification = (typeof INTEREST_CLASSIFICATIONS)[number];

/**
 * The snapshot keys evidence may cite. Evidence naming anything else is the model inventing
 * context it was never given, so the whole result is rejected.
 */
export const EVIDENCE_FIELDS = [
  "rawText",
  "urls",
  "userNote",
  "channel",
  "captureKind",
  "sourcePlatform",
  "capturedAt",
  "messageMetadata",
  "assets",
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

export const EVIDENCE_WEIGHTS = ["primary", "supporting"] as const;

export type EvidenceWeight = (typeof EVIDENCE_WEIGHTS)[number];

export interface IntentEvidence {
  field: EvidenceField;
  observation: string;
  weight: EvidenceWeight;
}

export interface IntentResult {
  contentType: ContentType;
  interest: { summary: string; confidence: number };
  classification: { value: InterestClassification; confidence: number };
  underlyingSource: { hints: readonly string[]; confidence: number };
  resolutionRequired: boolean;
  evidence: readonly IntentEvidence[];
}

export class IntentResultSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentResultSchemaError";
  }
}

function fail(message: string): never {
  throw new IntentResultSchemaError(message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireConfidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${field} must be a number between 0 and 1`);
  }

  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }

  return value;
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${field} must be one of: ${allowed.join(", ")}`);
  }

  return value as T;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${field} must be an array`);
  }

  return value;
}

function parseEvidence(value: unknown, index: number): IntentEvidence {
  const entry = requireRecord(value, `evidence[${index}]`);

  return {
    field: requireMember(entry.field, EVIDENCE_FIELDS, `evidence[${index}].field`),
    observation: requireNonEmptyString(entry.observation, `evidence[${index}].observation`),
    weight: requireMember(entry.weight, EVIDENCE_WEIGHTS, `evidence[${index}].weight`),
  };
}

/**
 * Parse an unvalidated model response into an `IntentResult`, or throw
 * `IntentResultSchemaError`. Unknown top-level keys are rejected rather than dropped: a model
 * volunteering a field we did not ask for is signal that the run should not be trusted.
 */
export function parseIntentResult(value: unknown): IntentResult {
  const candidate = requireRecord(value, "result");
  const known = new Set([
    "contentType",
    "interest",
    "classification",
    "underlyingSource",
    "resolutionRequired",
    "evidence",
  ]);
  const unexpected = Object.keys(candidate).filter((key) => !known.has(key));

  if (unexpected.length > 0) {
    fail(`result has unexpected fields: ${unexpected.sort().join(", ")}`);
  }

  const interest = requireRecord(candidate.interest, "interest");
  const classification = requireRecord(candidate.classification, "classification");
  const underlyingSource = requireRecord(candidate.underlyingSource, "underlyingSource");

  if (typeof candidate.resolutionRequired !== "boolean") {
    fail("resolutionRequired must be a boolean");
  }

  const evidence = requireArray(candidate.evidence, "evidence").map(parseEvidence);

  if (evidence.length === 0) {
    fail("evidence must cite at least one capture-time field");
  }

  return {
    contentType: requireMember(candidate.contentType, CONTENT_TYPES, "contentType"),
    interest: {
      summary: requireNonEmptyString(interest.summary, "interest.summary"),
      confidence: requireConfidence(interest.confidence, "interest.confidence"),
    },
    classification: {
      value: requireMember(
        classification.value,
        INTEREST_CLASSIFICATIONS,
        "classification.value",
      ),
      confidence: requireConfidence(classification.confidence, "classification.confidence"),
    },
    underlyingSource: {
      hints: requireArray(underlyingSource.hints, "underlyingSource.hints").map(
        (hint, index) => requireNonEmptyString(hint, `underlyingSource.hints[${index}]`),
      ),
      confidence: requireConfidence(
        underlyingSource.confidence,
        "underlyingSource.confidence",
      ),
    },
    resolutionRequired: candidate.resolutionRequired,
    evidence,
  };
}

/**
 * The single confidence recorded alongside the run. Deliberately the weakest of the three
 * component confidences rather than an extra model-supplied number: a result is only as
 * trustworthy as its least certain part, and a derived value cannot be inflated by the model.
 */
export function overallConfidence(result: IntentResult): number {
  return Math.min(
    result.interest.confidence,
    result.classification.confidence,
    result.underlyingSource.confidence,
  );
}
