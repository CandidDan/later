import {
  INTENT_ACCURACIES,
  RECALL_STATUSES,
  type CaptureContext,
  type IntentAccuracy,
  type RatingSubmission,
  type RecallStatus,
  type RecallSubmission,
} from "./types";

export class ResearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchInputError";
  }
}

function fail(message: string): never {
  throw new ResearchInputError(message);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("body must be an object");
  }

  return value as Record<string, unknown>;
}

export function parseCaptureId(value: unknown): string {
  return requireId(value, "captureId");
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    fail(`${field} must be an identifier`);
  }

  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${field} must be one of: ${allowed.join(", ")}`);
  }

  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${field} must be true or false`);
  }

  return value;
}

const MAX_FREE_TEXT = 2000;

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    fail(`${field} must be text`);
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_FREE_TEXT) {
    fail(`${field} must be at most ${MAX_FREE_TEXT} characters`);
  }

  return trimmed.length === 0 ? null : trimmed;
}

function rejectUnknownKeys(candidate: Record<string, unknown>, known: readonly string[]): void {
  const unexpected = Object.keys(candidate).filter((key) => !known.includes(key));

  if (unexpected.length > 0) {
    fail(`body has unexpected fields: ${unexpected.sort().join(", ")}`);
  }
}

/**
 * Parse a recall answer. An evaluator who cannot remember the capture has, by definition, no
 * remembered interest to give — accepting one anyway would record a guess as data.
 */
export function parseRecallSubmission(value: unknown): RecallSubmission {
  const candidate = requireRecord(value);
  rejectUnknownKeys(candidate, ["captureId", "recallStatus", "rememberedInterest"]);

  const recallStatus: RecallStatus = requireMember(
    candidate.recallStatus,
    RECALL_STATUSES,
    "recallStatus",
  );
  const rememberedInterest = optionalText(candidate.rememberedInterest, "rememberedInterest");

  if (recallStatus === "cannot_remember" && rememberedInterest !== null) {
    fail("rememberedInterest cannot accompany cannot_remember");
  }

  return {
    captureId: requireId(candidate.captureId, "captureId"),
    recallStatus,
    rememberedInterest,
  };
}

/** Parse a rating. It names the evaluation row, which is what binds it to one exact run. */
export function parseRatingSubmission(value: unknown): RatingSubmission {
  const candidate = requireRecord(value);
  rejectUnknownKeys(candidate, [
    "evaluationId",
    "intentAccuracy",
    "stillInterested",
    "consumedBeforeEvaluation",
    "notes",
  ]);

  const intentAccuracy: IntentAccuracy = requireMember(
    candidate.intentAccuracy,
    INTENT_ACCURACIES,
    "intentAccuracy",
  );

  return {
    evaluationId: requireId(candidate.evaluationId, "evaluationId"),
    intentAccuracy,
    stillInterested: requireBoolean(candidate.stillInterested, "stillInterested"),
    consumedBeforeEvaluation: requireBoolean(
      candidate.consumedBeforeEvaluation,
      "consumedBeforeEvaluation",
    ),
    notes: optionalText(candidate.notes, "notes"),
  };
}

/**
 * Narrow a capture row to the recall-phase view by naming every field explicitly.
 *
 * The allow-list is the point. A row read from the database may carry joined or future columns;
 * copying it wholesale is how an inferred summary reaches the evaluator before they have
 * answered from memory, and there is no way to take that back once they have read it.
 */
export function toCaptureContext(row: Record<string, unknown>): CaptureContext {
  const assets = Array.isArray(row.assets) ? row.assets : [];

  return {
    captureId: String(row.capture_id ?? row.id ?? ""),
    channel: String(row.capture_channel ?? ""),
    captureKind: String(row.capture_kind ?? "unknown"),
    rawText: typeof row.raw_text === "string" ? row.raw_text : null,
    userNote: typeof row.user_note === "string" ? row.user_note : null,
    sourcePlatform: typeof row.source_platform === "string" ? row.source_platform : null,
    capturedAt: String(row.captured_at ?? ""),
    assets: assets.map((asset) => {
      const entry = (asset ?? {}) as Record<string, unknown>;

      return {
        filename: String(entry.filename ?? ""),
        mediaType: typeof entry.media_type === "string" ? entry.media_type : null,
      };
    }),
  };
}
