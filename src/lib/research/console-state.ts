import type { CaptureContext, RevealedRun } from "./types";

/**
 * The console's phases. The server is the reveal boundary, but the client keeps its own
 * ordering honest too: `runs` exists on exactly one phase, and that phase is only reachable
 * after recall has been stored. A stray or replayed response therefore cannot put model output
 * on screen while the evaluator is still answering from memory.
 */
export type ConsoleState =
  | { phase: "loading" }
  | { phase: "signed_out"; message: string | null }
  | { phase: "recall"; capture: CaptureContext }
  | { phase: "recorded"; capture: CaptureContext }
  | { phase: "reveal"; capture: CaptureContext; runs: readonly RevealedRun[]; rated: readonly string[] }
  | { phase: "empty" }
  | { phase: "error"; message: string };

export type ConsoleEvent =
  | { type: "loading" }
  | { type: "loaded"; capture: CaptureContext | undefined }
  | { type: "resumed"; capture: CaptureContext; runs: readonly RevealedRun[] }
  | { type: "recall_stored" }
  | { type: "revealed"; runs: readonly RevealedRun[] }
  | { type: "rated"; evaluationId: string }
  | { type: "signed_out"; message: string | null }
  | { type: "failed"; message: string };

export const INITIAL_CONSOLE_STATE: ConsoleState = { phase: "loading" };

export function researchConsoleReducer(state: ConsoleState, event: ConsoleEvent): ConsoleState {
  switch (event.type) {
    case "loading":
      return { phase: "loading" };

    case "loaded":
      // One capture at a time. There is no list to hold, so there is no backlog to display.
      return event.capture ? { phase: "recall", capture: event.capture } : { phase: "empty" };

    case "resumed":
      // A fresh client may restore model output only when the server reports persisted recall.
      return state.phase === "loading"
        ? {
            phase: "reveal",
            capture: event.capture,
            runs: event.runs,
            rated: event.runs.filter((run) => run.rated).map((run) => run.evaluationId),
          }
        : state;

    case "recall_stored":
      return state.phase === "recall" ? { phase: "recorded", capture: state.capture } : state;

    case "revealed":
      // Only a console that has already stored recall may hold runs.
      return state.phase === "recorded"
        ? { phase: "reveal", capture: state.capture, runs: event.runs, rated: [] }
        : state;

    case "rated": {
      if (state.phase !== "reveal") {
        return state;
      }

      const rated = state.rated.includes(event.evaluationId)
        ? state.rated
        : [...state.rated, event.evaluationId];

      // Every run rated: drop this capture entirely and ask the server for the next one.
      return rated.length === state.runs.length ? { phase: "loading" } : { ...state, rated };
    }

    case "signed_out":
      return { phase: "signed_out", message: event.message };

    case "failed":
      return { phase: "error", message: event.message };
  }
}
