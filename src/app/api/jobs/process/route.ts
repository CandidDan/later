import { handleProcessJobsRequest } from "@/lib/jobs/handler";
import { createCaptureJobStore } from "@/lib/jobs/server";
import { processNextIntentJob, type IntentProcessingOutcome } from "@/lib/processing";
import { createIntentAnalyser } from "@/lib/processing/server";

export const runtime = "nodejs";

/**
 * Built on first use, not per request: an unauthenticated caller must not be able to trigger
 * credential lookups, and a batch must not rebuild the client for every job it drains.
 */
let dependencies: Parameters<typeof processNextIntentJob>[0] | undefined;

function processNext(): Promise<IntentProcessingOutcome> {
  dependencies ??= { store: createCaptureJobStore(), analyse: createIntentAnalyser() };

  return processNextIntentJob(dependencies);
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProcessJobsRequest(request, {
      secret: process.env.JOBS_PROCESS_SECRET ?? "",
      processNext,
    });
  } catch {
    return new Response("Job processing failed", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
