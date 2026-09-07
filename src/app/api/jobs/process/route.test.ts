import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureJobStore } from "@/lib/jobs/types";

const factories = vi.hoisted(() => ({ store: vi.fn(), analyser: vi.fn() }));
vi.mock("@/lib/jobs/server", () => ({ createCaptureJobStore: factories.store }));
vi.mock("@/lib/processing/server", () => ({ createIntentAnalyser: factories.analyser }));
// Resolve the application's aliases locally without changing shared test configuration.
vi.mock("@/lib/jobs/handler", () => import("../../../../lib/jobs/handler"));
vi.mock("@/lib/processing", () => import("../../../../lib/processing"));
const token = "TEST-ONLY-NOT-A-CREDENTIAL";

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("JOBS_PROCESS_SECRET", token); });

function request(bearer = token) {
  return new Request("https://test.invalid/api/jobs/process", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
}

describe("scheduled processing route", () => {
  it.each([undefined, "", "WRONG-TEST-VALUE"])("AC2 fails closed without constructing clients for %s", async (secret) => {
    vi.stubEnv("JOBS_PROCESS_SECRET", secret);
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(secret ? 401 : 503);
    expect(await response.text()).not.toContain(token);
    expect(factories.store).not.toHaveBeenCalled();
    expect(factories.analyser).not.toHaveBeenCalled();
  });

  it("AC1 processes a durable pending job independently of an inbound request", async () => {
    let pending = true;
    const finish = vi.fn<CaptureJobStore["finishAttempt"]>(async () => ({ analysisId: "analysis-test" }));
    const store: CaptureJobStore = {
      claimNextJob: async () => {
        if (!pending) return undefined;
        pending = false;
        return { id: "job-test", captureId: "capture-test", jobType: "intent_analysis", attempts: 1 };
      },
      loadCapture: async () => ({ id: "capture-test", channel: "whatsapp", captureKind: "text", rawText: "test capture", userNote: null, sourcePlatform: null, capturedAt: "2026-09-01T00:00:00Z", rawPayload: {}, assets: [] }),
      finishAttempt: finish,
    };
    factories.store.mockReturnValue(store);
    factories.analyser.mockReturnValue(async () => ({ modelId: "test-model", result: {
      contentType: "text", interest: { summary: "test", confidence: 0.8 }, classification: { value: "reference", confidence: 0.8 }, underlyingSource: { hints: [], confidence: 0.8 }, resolutionRequired: false, evidence: [],
    } }));
    const { POST } = await import("./route");
    const responses = await Promise.all([POST(request()), POST(request())]);
    const counts = await Promise.all(responses.map(r => r.json()));
    expect(counts.reduce((n, r) => n + r.succeeded, 0)).toBe(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempts: 1 }), expect.objectContaining({ status: "succeeded", captureId: "capture-test" }));
    expect(JSON.stringify(counts)).not.toMatch(/test capture|TEST-ONLY|analysis-test/u);
  });

  it("AC2 database/provider exceptions produce no secret-bearing output or logs", async () => {
    factories.store.mockImplementation(() => { throw new Error(token); });
    const errorLog = vi.spyOn(console, "error");
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Job processing failed");
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
