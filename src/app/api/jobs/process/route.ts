import type { MediaOutcome } from "@/lib/assets/process";
import { createMediaProcessor, createPrivateImageReader } from "@/lib/assets/server";
import { handleProcessJobsRequest } from "@/lib/jobs/handler";
import { createCaptureJobStore } from "@/lib/jobs/server";
import { processNextIntentJob, type IntentProcessingOutcome } from "@/lib/processing";
import { createIntentAnalyser } from "@/lib/processing/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Built on first use, not per request: an unauthenticated caller must not be able to trigger
 * credential lookups, and a batch must not rebuild the client for every job it drains.
 */
let dependencies: Parameters<typeof processNextIntentJob>[0] | undefined;

let mediaProcessor: ReturnType<typeof createMediaProcessor> | undefined;
let preferMedia = false;
let imageReader: ReturnType<typeof createPrivateImageReader> | undefined;
async function processNext(): Promise<IntentProcessingOutcome | MediaOutcome> {
  // Alternate queues so neither can starve the other. Credential lookups happen
  // only after authorization and only for the queue being processed.
  const intent = () => {
    dependencies ??= { store: createCaptureJobStore(), analyse: createIntentAnalyser(),
      readImage: async (asset) => {
        imageReader ??= createPrivateImageReader();
        return imageReader(asset);
      } };
    return processNextIntentJob(dependencies);
  };
  const media = () => {
    mediaProcessor ??= createMediaProcessor();
    return mediaProcessor();
  };
  preferMedia = !preferMedia;
  const intentFirst = preferMedia;
  const first = await (intentFirst ? intent() : media());
  return first.status === "idle" ? (intentFirst ? media() : intent()) : first;
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProcessJobsRequest(request, {
      secret: process.env.JOBS_PROCESS_SECRET ?? "",
      processNext,
      maxJobs: 2,
    });
  } catch {
    return new Response("Job processing failed", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
