import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({ dependencies: vi.fn() }));
vi.mock("@/lib/research/server", () => ({ createResearchDependencies: factories.dependencies }));
// Resolve the application's aliases locally without changing shared test configuration.
vi.mock("@/lib/research/handler", () => import("../../../lib/research/handler"));

const CAPTURE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const EVALUATION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

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

describe("research routes", () => {
  it("AC1 every research endpoint refuses an unauthenticated caller with no data", async () => {
    const storeFor = vi.fn();
    factories.dependencies.mockReturnValue({ authenticate: async () => undefined, storeFor });

    const [next, recall, reveal, rating] = await Promise.all([
      import("./next/route").then(({ GET }) => GET(get("/api/research/next"))),
      import("./recall/route").then(({ POST }) =>
        POST(post("/api/research/recall", { captureId: CAPTURE_ID, recallStatus: "remembered" })),
      ),
      import("./reveal/route").then(({ GET }) =>
        GET(get(`/api/research/reveal?captureId=${CAPTURE_ID}`)),
      ),
      import("./rating/route").then(({ POST }) =>
        POST(
          post("/api/research/rating", {
            evaluationId: EVALUATION_ID,
            intentAccuracy: "correct",
            stillInterested: true,
            consumedBeforeEvaluation: false,
          }),
        ),
      ),
    ]);
    const responses = [next, recall, reveal, rating];

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    await expect(Promise.all(responses.map((response) => response.text()))).resolves.toEqual(
      Array.from({ length: 4 }, () => JSON.stringify({ error: "unauthorized" })),
    );
    // No store, and therefore no database credential, is built for a rejected caller.
    expect(storeFor).not.toHaveBeenCalled();
  });

  it("AC2 the next-evaluation route returns the capture only", async () => {
    factories.dependencies.mockReturnValue({
      authenticate: async () => ({ userId: "user-test", accessToken: "TEST-ONLY-NOT-A-CREDENTIAL" }),
      storeFor: () => ({
        nextUnevaluatedCapture: async () => ({
          captureId: CAPTURE_ID,
          channel: "whatsapp",
          captureKind: "url",
          rawText: "https://example.test/pasta",
          userNote: null,
          sourcePlatform: null,
          capturedAt: "2026-09-01T10:00:00Z",
          assets: [],
        }),
        recordRecall: vi.fn(),
        revealRuns: vi.fn(),
        recordRating: vi.fn(),
      }),
    });

    const { GET } = await import("./next/route");
    const response = await GET(get("/api/research/next"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "recall" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
