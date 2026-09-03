import {
  CONTENT_TYPES,
  EVIDENCE_FIELDS,
  EVIDENCE_WEIGHTS,
  INTEREST_CLASSIFICATIONS,
} from "./intent-result";
import type { IntentInputSnapshot } from "./intent-input";
import type { JsonValue } from "../jobs/types";

/**
 * Both versions are recorded on every stored run. They change when the prompt or the
 * surrounding pipeline changes, so a later comparison can tell two runs apart without
 * anyone having to reconstruct what the code looked like at the time.
 */
export const PROMPT_VERSION = "intent-v0.1";
export const PIPELINE_VERSION = "intent-pipeline-v0.1";

export const INTENT_SYSTEM_PROMPT = [
  "You infer why a person saved something, from the context that existed at the moment they saved it.",
  "Give the narrowest reason the supplied context defends, not the broadest one it permits.",
  "You are given a capture-time snapshot and nothing else. No later evaluation, resolution, browsing or outcome data exists.",
  "Never infer from anything absent from the snapshot, and never report a field the snapshot does not contain.",
  "An explicit user note is the highest-signal evidence available. When the note conflicts with weaker surrounding context, follow the note and record the conflict.",
  `Every evidence entry must cite one of these snapshot fields: ${EVIDENCE_FIELDS.join(", ")}.`,
  "Set resolutionRequired only when identifying the underlying source is necessary before the capture can be acted on.",
  "State low confidence plainly rather than guessing; an uncertain classification is a valid answer.",
].join("\n");

/**
 * The JSON schema handed to the model, derived from the same constants the runtime validator
 * enforces so the two cannot drift apart.
 */
export const INTENT_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "contentType",
    "interest",
    "classification",
    "underlyingSource",
    "resolutionRequired",
    "evidence",
  ],
  properties: {
    contentType: { type: "string", enum: [...CONTENT_TYPES] },
    interest: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "confidence"],
      properties: {
        summary: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    classification: {
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence"],
      properties: {
        value: { type: "string", enum: [...INTEREST_CLASSIFICATIONS] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    underlyingSource: {
      type: "object",
      additionalProperties: false,
      required: ["hints", "confidence"],
      properties: {
        hints: { type: "array", items: { type: "string", minLength: 1 } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    resolutionRequired: { type: "boolean" },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "observation", "weight"],
        properties: {
          field: { type: "string", enum: [...EVIDENCE_FIELDS] },
          observation: { type: "string", minLength: 1 },
          weight: { type: "string", enum: [...EVIDENCE_WEIGHTS] },
        },
      },
    },
  },
};

export const HIGHEST_SIGNAL_PREFIX = "Highest-signal evidence:";

function evidencePrecedence(snapshot: IntentInputSnapshot): string {
  const note = snapshot.userNote?.trim();

  if (note === undefined || note.length === 0) {
    return `${HIGHEST_SIGNAL_PREFIX} none. No explicit user note was captured, so weigh the remaining snapshot fields on their own merits.`;
  }

  return [
    `${HIGHEST_SIGNAL_PREFIX} userNote — ${JSON.stringify(note)}.`,
    "The note is the person stating their own reason. It outranks every other snapshot field, and where it conflicts with weaker surrounding context you must follow the note and cite it with weight \"primary\".",
  ].join("\n");
}

/**
 * Serialise with object keys sorted at every depth. Two identical captures must produce a
 * byte-identical prompt, or the stored input snapshot stops being comparable evidence between
 * runs and the cached request prefix silently stops matching.
 */
function sortKeysDeeply(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeeply);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeysDeeply(value[key])]),
  );
}

/**
 * The user message for one run: the snapshot itself, then an explicit statement of which
 * field outranks the others.
 */
export function buildIntentUserMessage(snapshot: IntentInputSnapshot): string {
  return [
    "Capture-time snapshot (the complete and only context available):",
    JSON.stringify(sortKeysDeeply(snapshot), undefined, 2),
    "",
    evidencePrecedence(snapshot),
  ].join("\n");
}
