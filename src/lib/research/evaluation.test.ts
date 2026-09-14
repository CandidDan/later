import { describe, expect, it } from "vitest";

import {
  ResearchInputError,
  parseCaptureId,
  parseRatingSubmission,
  parseRecallSubmission,
  toCaptureContext,
} from "./evaluation";

const CAPTURE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const EVALUATION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";

describe("recall submissions", () => {
  it.each(["remembered", "partial"] as const)("AC3 accepts %s recall with the answer", (status) => {
    expect(
      parseRecallSubmission({
        captureId: CAPTURE_ID,
        recallStatus: status,
        rememberedInterest: "  the pasta recipe  ",
      }),
    ).toEqual({
      captureId: CAPTURE_ID,
      recallStatus: status,
      rememberedInterest: "the pasta recipe",
    });
  });

  it("AC3 accepts cannot-remember recall with no answer", () => {
    expect(
      parseRecallSubmission({ captureId: CAPTURE_ID, recallStatus: "cannot_remember" }),
    ).toEqual({ captureId: CAPTURE_ID, recallStatus: "cannot_remember", rememberedInterest: null });
  });

  it.each([
    ["a missing status", { captureId: CAPTURE_ID }],
    ["an invented status", { captureId: CAPTURE_ID, recallStatus: "sort_of" }],
    ["a non-identifier capture", { captureId: "../../etc/passwd", recallStatus: "partial" }],
    [
      "a contradictory cannot-remember answer",
      { captureId: CAPTURE_ID, recallStatus: "cannot_remember", rememberedInterest: "actually yes" },
    ],
    [
      "a field the console never asked for",
      { captureId: CAPTURE_ID, recallStatus: "partial", intentAccuracy: "correct" },
    ],
    ["a body that is not an object", ["partial"]],
  ])("AC6 rejects %s", (_name, body) => {
    expect(() => parseRecallSubmission(body)).toThrow(ResearchInputError);
  });
});

describe("rating submissions", () => {
  it("AC4 accepts a complete rating bound to one evaluation row", () => {
    expect(
      parseRatingSubmission({
        evaluationId: EVALUATION_ID,
        intentAccuracy: "close",
        stillInterested: false,
        consumedBeforeEvaluation: true,
        notes: " read it on the train ",
      }),
    ).toEqual({
      evaluationId: EVALUATION_ID,
      intentAccuracy: "close",
      stillInterested: false,
      consumedBeforeEvaluation: true,
      notes: "read it on the train",
    });
  });

  it.each([
    ["an invented accuracy", { evaluationId: EVALUATION_ID, intentAccuracy: "maybe", stillInterested: true, consumedBeforeEvaluation: false }],
    ["a missing follow-up answer", { evaluationId: EVALUATION_ID, intentAccuracy: "correct", stillInterested: true }],
    ["a non-boolean follow-up answer", { evaluationId: EVALUATION_ID, intentAccuracy: "correct", stillInterested: "yes", consumedBeforeEvaluation: false }],
    ["an unbound rating", { intentAccuracy: "correct", stillInterested: true, consumedBeforeEvaluation: false }],
  ])("AC6 rejects %s", (_name, body) => {
    expect(() => parseRatingSubmission(body)).toThrow(ResearchInputError);
  });

  it("AC6 rejects a note longer than the column is meant to hold", () => {
    expect(() =>
      parseRatingSubmission({
        evaluationId: EVALUATION_ID,
        intentAccuracy: "correct",
        stillInterested: true,
        consumedBeforeEvaluation: false,
        notes: "x".repeat(2001),
      }),
    ).toThrow(/at most 2000/u);
  });
});

describe("capture context", () => {
  it("AC2 copies capture-time fields only, dropping anything a row carries alongside them", () => {
    const context = toCaptureContext({
      capture_id: CAPTURE_ID,
      capture_channel: "whatsapp",
      capture_kind: "url",
      raw_text: "https://example.test/pasta",
      user_note: null,
      source_platform: "instagram",
      captured_at: "2026-09-01T10:00:00Z",
      assets: [{ filename: "photo.jpg", media_type: "image/jpeg" }],
      // Fields a joined or future row might carry. None of them may reach the recall phase.
      result: { interest: { summary: "wants the pasta recipe" } },
      model_id: "claude-haiku-4-5",
      confidence: 0.9,
    });

    expect(context).toEqual({
      captureId: CAPTURE_ID,
      channel: "whatsapp",
      captureKind: "url",
      rawText: "https://example.test/pasta",
      userNote: null,
      sourcePlatform: "instagram",
      capturedAt: "2026-09-01T10:00:00Z",
      assets: [{ filename: "photo.jpg", mediaType: "image/jpeg" }],
    });
    expect(JSON.stringify(context)).not.toMatch(/summary|claude-|confidence/iu);
  });

  it("AC6 tolerates a row with no assets or missing optional columns", () => {
    expect(toCaptureContext({ capture_id: CAPTURE_ID, capture_channel: "email" })).toMatchObject({
      captureKind: "unknown",
      rawText: null,
      userNote: null,
      sourcePlatform: null,
      assets: [],
    });
  });

  it("AC6 rejects a capture id that is not an identifier", () => {
    expect(parseCaptureId(CAPTURE_ID)).toBe(CAPTURE_ID);
    expect(() => parseCaptureId("' or 1=1 --")).toThrow(ResearchInputError);
  });
});
