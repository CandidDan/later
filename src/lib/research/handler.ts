import {
  ResearchInputError,
  parseCaptureId,
  parseRatingSubmission,
  parseRecallSubmission,
} from "./evaluation";
import type { ResearchSession, ResearchStore } from "./types";

export interface ResearchDependencies {
  /** Verify the presented session independently of anything the client claims. */
  authenticate(request: Request): Promise<ResearchSession | undefined>;
  /**
   * Build a store bound to the verified session's own credentials, so row-level security is
   * still the thing standing between one evaluator and another's captures.
   */
  storeFor(session: ResearchSession): ResearchStore;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * One response for every rejected caller. An unauthenticated request, an unknown token and a
 * signed-in stranger are indistinguishable from the outside and carry no capture, analysis or
 * evaluation data at all.
 */
function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

async function withSession(
  request: Request,
  dependencies: ResearchDependencies,
  handle: (store: ResearchStore) => Promise<Response>,
): Promise<Response> {
  const session = await dependencies.authenticate(request);

  if (!session) {
    return unauthorized();
  }

  try {
    return await handle(dependencies.storeFor(session));
  } catch (error) {
    if (error instanceof ResearchInputError) {
      return json({ error: "invalid_submission", detail: error.message }, 400);
    }

    // The message may name a row, a column or a credential; the caller gets none of it.
    return json({ error: "research_unavailable" }, 503);
  }
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ResearchInputError("body must be JSON");
  }
}

/**
 * The recall phase. The payload is the capture as it was saved and nothing else — no inferred
 * summary, no model id, no confidence — because reading any of those first is exactly the
 * contamination this experiment exists to avoid.
 */
export function handleNextEvaluation(
  request: Request,
  dependencies: ResearchDependencies,
): Promise<Response> {
  return withSession(request, dependencies, async (store) => {
    const pending = await store.nextUnevaluatedCapture();

    if (!pending) {
      return json({ phase: "empty" }, 200);
    }

    if (!pending.recallStored) {
      return json({ phase: "recall", capture: pending.capture }, 200);
    }

    // Resume from persisted state after a refresh/crash. The store still verifies that recall
    // rows exist before returning analysis fields; the view's boolean is routing, not authority.
    const outcome = await store.revealRuns(pending.capture.captureId);

    if (outcome.status === "recall_required") {
      throw new Error("pending evaluation lost its persisted recall");
    }

    return json({ phase: "reveal", capture: pending.capture, runs: outcome.runs }, 200);
  });
}

/**
 * Store the unaided recall answer. The response deliberately reports only that it was written:
 * revealing the analysis in the same round trip would make the stored answer worthless.
 */
export function handleRecallSubmission(
  request: Request,
  dependencies: ResearchDependencies,
): Promise<Response> {
  return withSession(request, dependencies, async (store) => {
    const submission = parseRecallSubmission(await body(request));
    const outcome = await store.recordRecall(submission);

    if (outcome === "no_eligible_runs") {
      return json({ error: "no_eligible_runs" }, 409);
    }

    return json(
      {
        phase: "recorded",
        captureId: outcome.captureId,
        runs: outcome.runs,
        repeated: outcome.repeated,
      },
      outcome.repeated ? 200 : 201,
    );
  });
}

/**
 * Release the frozen runs. The store refuses while no recall row exists, so the reveal boundary
 * is a server-side fact about stored data rather than a screen the client agreed not to draw.
 */
export function handleReveal(
  request: Request,
  dependencies: ResearchDependencies,
): Promise<Response> {
  return withSession(request, dependencies, async (store) => {
    const captureId = parseCaptureId(new URL(request.url).searchParams.get("captureId"));
    const outcome = await store.revealRuns(captureId);

    return outcome.status === "recall_required"
      ? json({ error: "recall_required" }, 409)
      : json({ phase: "reveal", captureId: outcome.captureId, runs: outcome.runs }, 200);
  });
}

/** Record the rating of one revealed run, bound to the evaluation row that names its analysis. */
export function handleRatingSubmission(
  request: Request,
  dependencies: ResearchDependencies,
): Promise<Response> {
  return withSession(request, dependencies, async (store) => {
    const submission = parseRatingSubmission(await body(request));
    const outcome = await store.recordRating(submission);

    if (outcome.status === "unknown") {
      return json({ error: "unknown_evaluation" }, 404);
    }

    if (outcome.status === "not_revealed") {
      return json({ error: "recall_required" }, 409);
    }

    return json(
      { phase: "rated", evaluationId: submission.evaluationId, repeated: outcome.repeated },
      200,
    );
  });
}
