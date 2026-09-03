import { describe, expect, it } from "vitest";

import {
  IntentResultSchemaError,
  overallConfidence,
  parseIntentResult,
  type IntentResult,
} from "./intent-result";

function validResponse(): Record<string, unknown> {
  return {
    contentType: "recipe",
    interest: { summary: "Wants to cook this specific braise", confidence: 0.8 },
    classification: { value: "atomic", confidence: 0.7 },
    underlyingSource: { hints: ["instagram reel"], confidence: 0.6 },
    resolutionRequired: true,
    evidence: [
      { field: "userNote", observation: "asked to cook it on Sunday", weight: "primary" },
      { field: "urls", observation: "a single instagram link", weight: "supporting" },
    ],
  };
}

describe("parseIntentResult", () => {
  it("AC1 accepts a complete v0 result and preserves every validated field", () => {
    const result = parseIntentResult(validResponse());

    expect(result).toStrictEqual<IntentResult>({
      contentType: "recipe",
      interest: { summary: "Wants to cook this specific braise", confidence: 0.8 },
      classification: { value: "atomic", confidence: 0.7 },
      underlyingSource: { hints: ["instagram reel"], confidence: 0.6 },
      resolutionRequired: true,
      evidence: [
        { field: "userNote", observation: "asked to cook it on Sunday", weight: "primary" },
        { field: "urls", observation: "a single instagram link", weight: "supporting" },
      ],
    });
  });

  it.each([
    ["a missing content type", { contentType: undefined }],
    ["an unknown content type", { contentType: "newsletter" }],
    ["an unknown classification", { classification: { value: "maybe", confidence: 0.5 } }],
    ["a confidence above one", { interest: { summary: "ok", confidence: 1.4 } }],
    ["a non-numeric confidence", { interest: { summary: "ok", confidence: "high" } }],
    ["an empty summary", { interest: { summary: "   ", confidence: 0.5 } }],
    ["a non-boolean resolution flag", { resolutionRequired: "yes" }],
    ["no evidence at all", { evidence: [] }],
    ["evidence with an unknown weight", {
      evidence: [{ field: "urls", observation: "link", weight: "decisive" }],
    }],
  ])("AC3 rejects %s", (_label, patch) => {
    expect(() => parseIntentResult({ ...validResponse(), ...patch })).toThrow(
      IntentResultSchemaError,
    );
  });

  it("AC3 rejects evidence citing a field the capture snapshot never contained", () => {
    const fabricated = {
      ...validResponse(),
      evidence: [{ field: "resolvedSource", observation: "the real recipe", weight: "primary" }],
    };

    expect(() => parseIntentResult(fabricated)).toThrow(/evidence\[0\]\.field/u);
  });

  it("AC3 rejects a result carrying a retrospective field outside the v0 shape", () => {
    const fabricated = { ...validResponse(), resolutionOutcome: "matched" };

    expect(() => parseIntentResult(fabricated)).toThrow(/unexpected fields: resolutionOutcome/u);
  });

  it("AC1 records the weakest component confidence as the run's confidence", () => {
    expect(overallConfidence(parseIntentResult(validResponse()))).toBe(0.6);
  });
});
