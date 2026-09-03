import { describe, expect, it } from "vitest";

import { HIGHEST_SIGNAL_PREFIX, INTENT_SYSTEM_PROMPT, buildIntentUserMessage } from "./prompt";
import { buildIntentInputSnapshot } from "./intent-input";
import type { CaptureRecord } from "../jobs/types";

/**
 * The note says one thing ("just the sauce technique") while the surrounding context suggests
 * another (a whole-meal recipe link). The request must make the note's precedence explicit.
 */
function conflictingCapture(): CaptureRecord {
  return {
    id: "capture-2",
    channel: "whatsapp",
    captureKind: "mixed",
    rawText: "Ultimate 12-course feast menu https://example.com/feast",
    userNote: "only saving this for the sauce technique",
    sourcePlatform: null,
    capturedAt: "2026-09-01T11:00:00.000Z",
    rawPayload: { NumSegments: "1" },
    assets: [],
  };
}

describe("buildIntentUserMessage", () => {
  it("AC2 marks an explicit note as the highest-signal evidence outranking weaker context", () => {
    const message = buildIntentUserMessage(buildIntentInputSnapshot(conflictingCapture()));

    expect(message).toContain(`${HIGHEST_SIGNAL_PREFIX} userNote —`);
    expect(message).toContain("only saving this for the sauce technique");
    expect(message).toContain("It outranks every other snapshot field");
    expect(message).toMatch(/follow the note/u);
  });

  it("AC2 says plainly when there is no note, instead of promoting weaker context", () => {
    const withoutNote = { ...conflictingCapture(), userNote: null };
    const message = buildIntentUserMessage(buildIntentInputSnapshot(withoutNote));

    expect(message).toContain(`${HIGHEST_SIGNAL_PREFIX} none.`);
    expect(message).not.toContain("It outranks every other snapshot field");
  });

  it("AC2 sends only the capture snapshot, naming no retrospective or resolution field", () => {
    const message = buildIntentUserMessage(buildIntentInputSnapshot(conflictingCapture()));

    expect(message).not.toMatch(/resolv|resurfac|recommend|evaluation|outcome/iu);
    expect(INTENT_SYSTEM_PROMPT).toContain("No later evaluation, resolution, browsing or outcome data exists.");
    expect(INTENT_SYSTEM_PROMPT).toContain("Never infer from anything absent from the snapshot");
  });

  it("AC4 serialises identical captures identically, so runs stay comparable", () => {
    const first = buildIntentUserMessage(buildIntentInputSnapshot(conflictingCapture()));
    const second = buildIntentUserMessage(buildIntentInputSnapshot(conflictingCapture()));

    expect(first).toBe(second);
  });
});
