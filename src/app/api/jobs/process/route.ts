import type { MediaOutcome } from "@/lib/assets/process";
import { createMediaProcessor, createPrivateImageReader } from "@/lib/assets/server";
import type { EmailEnrichmentOutcome } from "@/lib/email/enrich";
import { createEmailEnrichmentProcessor } from "@/lib/email/server";
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
let emailProcessor: ReturnType<typeof createEmailEnrichmentProcessor> | undefined;
let nextQueue = 0;
let imageReader: ReturnType<typeof createPrivateImageReader> | undefined;

type Outcome = IntentProcessingOutcome | MediaOutcome | EmailEnrichmentOutcome;

async function processNext(): Promise<Outcome> {
  // Rotate the queues so none can starve the others. Credential lookups happen only after
  // authorization and only for the queue being processed.
  const queues: Array<() => Promise<Outcome>> = [
    () => {
      dependencies ??= { store: createCaptureJobStore(), analyse: createIntentAnalyser(),
        readImage: async (asset) => {
          imageReader ??= createPrivateImageReader();
          return imageReader(asset);
        } };
      return processNextIntentJob(dependencies);
    },
    () => {
      mediaProcessor ??= createMediaProcessor();
      return mediaProcessor();
    },
    async () => {
      // Inbound email is optional configuration. A deployment that has not set it up must
      // still drain the other queues, so an unconfigured channel reads as an empty one.
      try {
        emailProcessor ??= createEmailEnrichmentProcessor();
      } catch {
        return { status: "idle" };
      }
      return emailProcessor();
    },
  ];

  nextQueue = (nextQueue + 1) % queues.length;

  for (let offset = 0; offset < queues.length; offset += 1) {
    const outcome = await queues[(nextQueue + offset) % queues.length]();
    if (outcome.status !== "idle") return outcome;
  }

  return { status: "idle" };
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
