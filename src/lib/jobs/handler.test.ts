import { describe, expect, it, vi } from "vitest";

import { handleProcessJobsRequest } from "./handler";
import type { IntentProcessingOutcome } from "../processing/intent";

function request(authorization?: string): Request {
  return new Request("https://later.example/api/jobs/process", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
}

const succeeded: IntentProcessingOutcome = {
  status: "succeeded",
  jobId: "job-1",
  captureId: "capture-1",
  analysisId: "analysis-1",
  modelId: "claude-haiku-4-5",
};

describe("handleProcessJobsRequest", () => {
  it("AC7 refuses an unauthenticated caller without touching intent processing", async () => {
    const processNext = vi.fn(async (): Promise<IntentProcessingOutcome> => succeeded);

    const response = await handleProcessJobsRequest(request(), { secret: "s3cret", processNext });

    expect(response.status).toBe(401);
    expect(processNext).not.toHaveBeenCalled();
  });

  it("AC7 refuses a wrong secret without touching intent processing", async () => {
    const processNext = vi.fn(async (): Promise<IntentProcessingOutcome> => succeeded);

    const response = await handleProcessJobsRequest(request("Bearer wrong-secret"), {
      secret: "s3cret",
      processNext,
    });

    expect(response.status).toBe(401);
    expect(processNext).not.toHaveBeenCalled();
  });

  it("AC7 reports the endpoint as unconfigured rather than open when no secret is set", async () => {
    const processNext = vi.fn(async (): Promise<IntentProcessingOutcome> => succeeded);

    const response = await handleProcessJobsRequest(request("Bearer anything"), {
      secret: "  ",
      processNext,
    });

    expect(response.status).toBe(503);
    expect(processNext).not.toHaveBeenCalled();
  });

  it("AC1 drains pending jobs and reports counts only, never the analysis itself", async () => {
    const outcomes: IntentProcessingOutcome[] = [
      succeeded,
      { status: "failed", jobId: "job-2", captureId: "capture-2", errorCode: "provider_unavailable" },
      { status: "idle" },
    ];
    const processNext = vi.fn(
      async (): Promise<IntentProcessingOutcome> => outcomes.shift() ?? { status: "idle" },
    );

    const response = await handleProcessJobsRequest(request("Bearer s3cret"), {
      secret: "s3cret",
      processNext,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toStrictEqual({ claimed: 2, succeeded: 1, failed: 1 });
    expect(body).not.toMatch(/summary|interest|evidence|contentType/u);
    expect(processNext).toHaveBeenCalledTimes(3);
  });

  it("AC1 stops at the batch ceiling instead of draining without bound", async () => {
    const processNext = vi.fn(async (): Promise<IntentProcessingOutcome> => succeeded);

    await handleProcessJobsRequest(request("Bearer s3cret"), {
      secret: "s3cret",
      processNext,
      maxJobs: 3,
    });

    expect(processNext).toHaveBeenCalledTimes(3);
  });
});
