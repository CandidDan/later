import { describe, expect, it } from "vitest";

import {
  INITIAL_CONSOLE_STATE,
  researchConsoleReducer,
  type ConsoleState,
} from "./console-state";
import type { CaptureContext, RevealedRun } from "./types";

const capture: CaptureContext = {
  captureId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  channel: "whatsapp",
  captureKind: "url",
  rawText: "https://example.test/pasta",
  userNote: null,
  sourcePlatform: null,
  capturedAt: "2026-09-01T10:00:00Z",
  assets: [],
};

const haikuRun: RevealedRun = {
  evaluationId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1",
  analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc1",
  modelId: "claude-haiku-4-5",
  promptVersion: "v1",
  pipelineVersion: "v1",
  analysedAt: "2026-09-01T10:01:00Z",
  confidence: 0.8,
  result: { interest: { summary: "wants the pasta recipe" } },
  rated: false,
};
const sonnetRun: RevealedRun = {
  ...haikuRun,
  evaluationId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2",
  analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc2",
  modelId: "claude-sonnet-5",
};

function reduce(state: ConsoleState, ...events: Parameters<typeof researchConsoleReducer>[1][]) {
  return events.reduce(researchConsoleReducer, state);
}

describe("research console state", () => {
  it("AC2 holds no run until recall has been stored", () => {
    const recallPhase = reduce(INITIAL_CONSOLE_STATE, { type: "loaded", capture });

    expect(recallPhase).toEqual({ phase: "recall", capture });
    // A stray or replayed reveal response cannot put model output on screen mid-recall.
    expect(reduce(recallPhase, { type: "revealed", runs: [haikuRun] })).toEqual(recallPhase);
    expect(JSON.stringify(recallPhase)).not.toMatch(/haiku|sonnet|summary|confidence/iu);
  });

  it("AC4 reveals the runs only after the recall_stored transition", () => {
    const revealed = reduce(
      INITIAL_CONSOLE_STATE,
      { type: "loaded", capture },
      { type: "recall_stored" },
      { type: "revealed", runs: [haikuRun, sonnetRun] },
    );

    expect(revealed).toEqual({ phase: "reveal", capture, runs: [haikuRun, sonnetRun], rated: [] });
  });

  it("AC6 restores a persisted incomplete evaluation after client state is lost", () => {
    const ratedHaiku = { ...haikuRun, rated: true };
    const resumed = reduce(INITIAL_CONSOLE_STATE, {
      type: "resumed",
      capture,
      runs: [ratedHaiku, sonnetRun],
    });

    expect(resumed).toEqual({
      phase: "reveal",
      capture,
      runs: [ratedHaiku, sonnetRun],
      rated: [haikuRun.evaluationId],
    });
  });

  it("AC5 tracks each run's rating separately and only finishes when both are recorded", () => {
    const revealed = reduce(
      INITIAL_CONSOLE_STATE,
      { type: "loaded", capture },
      { type: "recall_stored" },
      { type: "revealed", runs: [haikuRun, sonnetRun] },
    );
    const oneRated = reduce(revealed, { type: "rated", evaluationId: haikuRun.evaluationId });

    expect(oneRated).toMatchObject({ phase: "reveal", rated: [haikuRun.evaluationId] });
    // A repeated rating is not a second data point.
    expect(reduce(oneRated, { type: "rated", evaluationId: haikuRun.evaluationId })).toEqual(oneRated);
    expect(
      reduce(oneRated, { type: "rated", evaluationId: sonnetRun.evaluationId }),
    ).toEqual({ phase: "loading" });
  });

  it("AC6 settles on an empty phase with no count when nothing is eligible", () => {
    expect(reduce(INITIAL_CONSOLE_STATE, { type: "loaded", capture: undefined })).toEqual({
      phase: "empty",
    });
  });

  it("AC6 settles on a stable error or signed-out phase carrying no research data", () => {
    const failed = reduce(
      INITIAL_CONSOLE_STATE,
      { type: "loaded", capture },
      { type: "failed", message: "The research console is unavailable right now." },
    );
    const signedOut = reduce(failed, { type: "signed_out", message: null });

    expect(failed).toEqual({
      phase: "error",
      message: "The research console is unavailable right now.",
    });
    expect(signedOut).toEqual({ phase: "signed_out", message: null });
    expect(JSON.stringify([failed, signedOut])).not.toMatch(/pasta|haiku|sonnet/iu);
  });

  it("AC7 replaces the single capture rather than accumulating a list", () => {
    const second = { ...capture, captureId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2" };
    const state = reduce(
      INITIAL_CONSOLE_STATE,
      { type: "loaded", capture },
      { type: "loaded", capture: second },
    );

    expect(state).toEqual({ phase: "recall", capture: second });
  });
});
