import { timingSafeEqual } from "node:crypto";

import type { IntentProcessingOutcome } from "../processing/intent";

const DEFAULT_MAX_JOBS = 10;

export interface ProcessJobsDependencies {
  /** The shared secret callers must present. An empty value disables the endpoint. */
  secret: string;
  processNext: () => Promise<IntentProcessingOutcome>;
  maxJobs?: number;
}

export interface ProcessJobsSummary {
  claimed: number;
  succeeded: number;
  failed: number;
}

function json(body: ProcessJobsSummary, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function plainText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function presentedSecret(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/u.exec(header);

  return match?.[1] ?? "";
}

function secretMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak the secret's length.
  return (
    presentedBytes.length === expectedBytes.length &&
    timingSafeEqual(presentedBytes, expectedBytes)
  );
}

/**
 * Drain pending intent jobs, one claim at a time, up to a bounded batch.
 *
 * The response is a count of what happened and never the analysis itself: intent stays in
 * shadow mode, so nothing here is a surface a user could read a result from.
 */
export async function handleProcessJobsRequest(
  request: Request,
  dependencies: ProcessJobsDependencies,
): Promise<Response> {
  if (dependencies.secret.trim().length === 0) {
    return plainText("Job processing is not configured", 503);
  }

  if (!secretMatches(presentedSecret(request), dependencies.secret)) {
    return plainText("Unauthorized", 401);
  }

  const maxJobs = dependencies.maxJobs ?? DEFAULT_MAX_JOBS;
  const summary: ProcessJobsSummary = { claimed: 0, succeeded: 0, failed: 0 };

  for (let processed = 0; processed < maxJobs; processed += 1) {
    const outcome = await dependencies.processNext();

    if (outcome.status === "idle") {
      break;
    }

    summary.claimed += 1;
    summary[outcome.status] += 1;
  }

  return json(summary, 200);
}
