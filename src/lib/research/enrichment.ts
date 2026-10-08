import { parseCaptureId, ResearchInputError } from "./evaluation";
import type { ResearchDependencies } from "./handler";
import type { ResearchSession } from "./types";
import { handleAsset, handleCard } from "../revisit/handler";
import type { RevisitStore } from "../revisit/store";

export interface ResearchEnrichmentDependencies extends ResearchDependencies {
  revisitStoreFor(session: ResearchSession): RevisitStore;
}

/** Research enrichment has the same durable recall boundary as frozen model output.
 * Delegate only after that check, retaining the shared ownership/exposure/asset protections.
 */
export async function handleResearchEnrichment(
  request: Request, captureId: string, assetId: string | undefined,
  deps: ResearchEnrichmentDependencies,
): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
  const failure = (status: number, error: string) => Response.json({ error }, { status, headers });
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401, "unauthorized");
    const id = parseCaptureId(captureId);
    const outcome = await deps.storeFor(session).revealRuns(id);
    if (outcome.status !== "revealed") return failure(409, "recall_required");
    const revisit = { authenticate: async () => session, storeFor: deps.revisitStoreFor };
    return assetId === undefined
      ? handleCard(request, id, revisit)
      : handleAsset(request, id, assetId, revisit);
  } catch (error) {
    return error instanceof ResearchInputError
      ? failure(400, "invalid_submission") : failure(503, "research_unavailable");
  }
}
