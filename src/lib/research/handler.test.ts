import { describe, expect, it, vi } from "vitest";

import {
  handleNextEvaluation,
  handleRatingSubmission,
  handleRecallSubmission,
  handleReveal,
  type ResearchDependencies,
} from "./handler";
import type { CaptureContext, ResearchStore, RevealedRun } from "./types";

const CAPTURE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const HAIKU_EVALUATION = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";
const SONNET_EVALUATION = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2";

const capture: CaptureContext = {
  captureId: CAPTURE_ID,
  channel: "whatsapp",
  captureKind: "url",
  rawText: "https://example.test/pasta",
  userNote: "for sunday",
  sourcePlatform: null,
  capturedAt: "2026-09-01T10:00:00Z",
  assets: [],
};

const haikuRun: RevealedRun = {
  evaluationId: HAIKU_EVALUATION,
  analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc1",
  modelId: "claude-haiku-4-5",
  promptVersion: "v1",
  pipelineVersion: "v1",
  analysedAt: "2026-09-01T10:01:00Z",
  confidence: 0.8,
  result: { interest: { summary: "wants the pasta recipe" } },
  rated: false,
};

const sonnetRun: RevealedRun = { ...haikuRun, evaluationId: SONNET_EVALUATION, analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc2", modelId: "claude-sonnet-5", promptVersion: "v2", result: { interest: { summary: "wants a weeknight dinner idea" } } };

function store(overrides: Partial<ResearchStore> = {}): ResearchStore {
  return {
    nextUnevaluatedCapture: async () => ({ capture, recallStored: false }),
    recordRecall: async () => ({ captureId: CAPTURE_ID, runs: 2, repeated: false }),
    revealRuns: async () => ({ status: "revealed", captureId: CAPTURE_ID, runs: [haikuRun, sonnetRun] }),
    recordRating: async () => ({ status: "rated", repeated: false }),
    ...overrides,
  };
}

function dependencies(overrides: Partial<ResearchDependencies> = {}): ResearchDependencies {
  return {
    authenticate: async () => ({ userId: "user-test", accessToken: "TEST-ONLY-NOT-A-CREDENTIAL" }),
    storeFor: () => store(),
    ...overrides,
  };
}

function get(path: string): Request {
  return new Request(`https://test.invalid${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`https://test.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const recallBody = {
  captureId: CAPTURE_ID,
  recallStatus: "remembered",
  rememberedInterest: "the pasta recipe",
};

describe("research API", () => {
  it("AC1 returns no capture, analysis or evaluation data to a rejected caller", async () => {
    const storeFor = vi.fn(() => store());
    const deps = dependencies({ authenticate: async () => undefined, storeFor });
    const responses = await Promise.all([
      handleNextEvaluation(get("/api/research/next"), deps),
      handleRecallSubmission(post("/api/research/recall", recallBody), deps),
      handleReveal(get(`/api/research/reveal?captureId=${CAPTURE_ID}`), deps),
      handleRatingSubmission(
        post("/api/research/rating", {
          evaluationId: HAIKU_EVALUATION,
          intentAccuracy: "correct",
          stillInterested: true,
          consumedBeforeEvaluation: false,
        }),
        deps,
      ),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(bodies).toEqual(Array.from({ length: 4 }, () => JSON.stringify({ error: "unauthorized" })));
    // A rejected caller must not even cause a query to be built against the store.
    expect(storeFor).not.toHaveBeenCalled();
  });

  it("AC2 the recall payload carries the capture and no inferred field", async () => {
    const response = await handleNextEvaluation(get("/api/research/next"), dependencies());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ phase: "recall", capture });
    expect(JSON.stringify(payload)).not.toMatch(
      /summary|confidence|model|prompt_version|promptVersion|analysis/iu,
    );
  });

  it("AC6 resumes persisted recall directly at reveal after client state is lost", async () => {
    const revealRuns = vi.fn<ResearchStore["revealRuns"]>(async () => ({
      status: "revealed",
      captureId: CAPTURE_ID,
      runs: [haikuRun, sonnetRun],
    }));
    const response = await handleNextEvaluation(
      get("/api/research/next"),
      dependencies({
        storeFor: () =>
          store({
            nextUnevaluatedCapture: async () => ({ capture, recallStored: true }),
            revealRuns,
          }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      phase: "reveal",
      capture,
      runs: [haikuRun, sonnetRun],
    });
    expect(revealRuns).toHaveBeenCalledWith(CAPTURE_ID);
  });

  it("AC3 the recall response reveals nothing beyond the fact that the answer was stored", async () => {
    const recorded: unknown[] = [];
    const response = await handleRecallSubmission(
      post("/api/research/recall", recallBody),
      dependencies({
        storeFor: () =>
          store({
            recordRecall: async (submission) => {
              recorded.push(submission);
              return { captureId: CAPTURE_ID, runs: 2, repeated: false };
            },
          }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(recorded).toEqual([
      { captureId: CAPTURE_ID, recallStatus: "remembered", rememberedInterest: "the pasta recipe" },
    ]);
    expect(payload).toEqual({ phase: "recorded", captureId: CAPTURE_ID, runs: 2, repeated: false });
    expect(JSON.stringify(payload)).not.toMatch(/pasta|haiku|sonnet|interest|result/iu);
  });

  it("AC3 rejects a recall answer that contradicts itself", async () => {
    const recordRecall = vi.fn<ResearchStore["recordRecall"]>();
    const response = await handleRecallSubmission(
      post("/api/research/recall", {
        captureId: CAPTURE_ID,
        recallStatus: "cannot_remember",
        rememberedInterest: "but actually I do",
      }),
      dependencies({ storeFor: () => store({ recordRecall }) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_submission" });
    expect(recordRecall).not.toHaveBeenCalled();
  });

  it("AC4 the reveal shows the exact stored runs once recall exists", async () => {
    const response = await handleReveal(
      get(`/api/research/reveal?captureId=${CAPTURE_ID}`),
      dependencies(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      phase: "reveal",
      captureId: CAPTURE_ID,
      runs: [haikuRun, sonnetRun],
    });
  });

  it("AC4 refuses the reveal, with no analysis field, while recall is missing", async () => {
    const response = await handleReveal(
      get(`/api/research/reveal?captureId=${CAPTURE_ID}`),
      dependencies({ storeFor: () => store({ revealRuns: async () => ({ status: "recall_required" }) }) }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe(JSON.stringify({ error: "recall_required" }));
  });

  it("AC5 each rating names the evaluation row that binds it to one run", async () => {
    const rated: string[] = [];
    const deps = dependencies({
      storeFor: () =>
        store({
          recordRating: async (submission) => {
            rated.push(submission.evaluationId);
            return { status: "rated", repeated: false };
          },
        }),
    });
    const responses = await Promise.all(
      [
        { evaluationId: HAIKU_EVALUATION, intentAccuracy: "correct" },
        { evaluationId: SONNET_EVALUATION, intentAccuracy: "wrong" },
      ].map((rating) =>
        handleRatingSubmission(
          post("/api/research/rating", {
            ...rating,
            stillInterested: true,
            consumedBeforeEvaluation: false,
          }),
          deps,
        ),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(rated).toEqual([HAIKU_EVALUATION, SONNET_EVALUATION]);
    expect(await responses[0].json()).toEqual({
      phase: "rated",
      evaluationId: HAIKU_EVALUATION,
      repeated: false,
    });
  });

  it("AC6 reports a stable outcome when nothing is eligible", async () => {
    const empty = dependencies({
      storeFor: () => store({ nextUnevaluatedCapture: async () => undefined }),
    });
    const response = await handleNextEvaluation(get("/api/research/next"), empty);

    expect(response.status).toBe(200);
    // An empty phase, never a queue length: a count would turn the console into a backlog.
    expect(await response.json()).toEqual({ phase: "empty" });
  });

  it("AC6 reports a repeated recall submission as idempotent rather than duplicating it", async () => {
    const response = await handleRecallSubmission(
      post("/api/research/recall", recallBody),
      dependencies({
        storeFor: () =>
          store({ recordRecall: async () => ({ captureId: CAPTURE_ID, runs: 2, repeated: true }) }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "recorded", repeated: true });
  });

  it("AC6 surfaces a store failure without fabricating research data or leaking detail", async () => {
    const response = await handleNextEvaluation(
      get("/api/research/next"),
      dependencies({
        storeFor: () =>
          store({
            nextUnevaluatedCapture: async () => {
              throw new Error("capture_evaluations: permission denied for TEST-ONLY-NOT-A-CREDENTIAL");
            },
          }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({ error: "research_unavailable" }));
  });

  it("AC6 refuses a rating for an unknown or unrevealed evaluation", async () => {
    const rating = {
      evaluationId: HAIKU_EVALUATION,
      intentAccuracy: "correct",
      stillInterested: true,
      consumedBeforeEvaluation: false,
    };
    const [unknown, unrevealed] = await Promise.all([
      handleRatingSubmission(
        post("/api/research/rating", rating),
        dependencies({ storeFor: () => store({ recordRating: async () => ({ status: "unknown" }) }) }),
      ),
      handleRatingSubmission(
        post("/api/research/rating", rating),
        dependencies({
          storeFor: () => store({ recordRating: async () => ({ status: "not_revealed" }) }),
        }),
      ),
    ]);

    expect(unknown.status).toBe(404);
    expect(unrevealed.status).toBe(409);
  });

  it("AC6 rejects a malformed body and an unusable capture id", async () => {
    const deps = dependencies();
    const [notJson, badId] = await Promise.all([
      handleRecallSubmission(
        new Request("https://test.invalid/api/research/recall", { method: "POST", body: "{" }),
        deps,
      ),
      handleReveal(get("/api/research/reveal?captureId=../../etc"), deps),
    ]);

    expect(notJson.status).toBe(400);
    expect(badId.status).toBe(400);
  });
});
