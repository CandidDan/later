/**
 * The research console's vocabulary. Everything here is deliberately split in two: what an
 * evaluator may see *before* they answer from memory, and what is only allowed to exist after
 * their recall is durably stored. Keeping the two in separate types is what makes a hindsight
 * leak a type error rather than a review comment.
 */

export const RECALL_STATUSES = ["remembered", "partial", "cannot_remember"] as const;

export type RecallStatus = (typeof RECALL_STATUSES)[number];

export const INTENT_ACCURACIES = ["correct", "close", "wrong"] as const;

export type IntentAccuracy = (typeof INTENT_ACCURACIES)[number];

/** A capture exactly as it was saved. No field on this type is model output. */
export interface CaptureContext {
  captureId: string;
  channel: string;
  captureKind: string;
  rawText: string | null;
  userNote: string | null;
  sourcePlatform: string | null;
  capturedAt: string;
  assets: readonly { filename: string; mediaType: string | null }[];
}

/** One frozen analysis run, released only after recall is stored. */
export interface RevealedRun {
  evaluationId: string;
  analysisId: string;
  modelId: string;
  promptVersion: string;
  pipelineVersion: string;
  analysedAt: string;
  confidence: number | null;
  result: unknown;
  rated: boolean;
}

export interface RecallSubmission {
  captureId: string;
  recallStatus: RecallStatus;
  /** The evaluator's own words, written before any model output is released to them. */
  rememberedInterest: string | null;
}

export interface RatingSubmission {
  evaluationId: string;
  intentAccuracy: IntentAccuracy;
  stillInterested: boolean;
  consumedBeforeEvaluation: boolean;
  notes: string | null;
}

export interface RecallOutcome {
  captureId: string;
  /** How many runs this one recall answer now covers. */
  runs: number;
  /** True when the same recall had already been stored, so nothing new was written. */
  repeated: boolean;
}

export type RevealOutcome =
  | { status: "revealed"; captureId: string; runs: readonly RevealedRun[] }
  | { status: "recall_required" };

export type RatingOutcome = { status: "rated" } | { status: "unknown" } | { status: "not_revealed" };

/**
 * The data the console needs, expressed so the handlers can be tested without a database.
 * Every implementation must be bound to the evaluator's own credentials so row-level security
 * remains the enforcement, not a filter the application remembers to apply.
 */
export interface ResearchStore {
  /** The oldest capture with a successful intent run this evaluator has not yet evaluated. */
  nextUnevaluatedCapture(): Promise<CaptureContext | undefined>;
  recordRecall(submission: RecallSubmission): Promise<RecallOutcome | "no_eligible_runs">;
  /** Marks the runs revealed and returns them, or refuses while recall is missing. */
  revealRuns(captureId: string): Promise<RevealOutcome>;
  recordRating(submission: RatingSubmission): Promise<RatingOutcome>;
}

/** A session the server has verified for itself, never one the client asserted. */
export interface ResearchSession {
  userId: string;
  accessToken: string;
}
