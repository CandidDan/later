import type { ResearchSession } from "../research/types";
import { parseLibraryQuery, validId } from "./cursor";
import type { AppStore } from "./store";
export interface AppDependencies {
  authenticate(request: Request): Promise<ResearchSession | undefined>;
  storeFor(session: ResearchSession): AppStore;
}
const headers = { "Cache-Control": "private, no-store", "Vary": "Authorization", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) => Response.json({ error: status === 401 ? "Unauthorized" : "Unavailable" }, { status, headers });
export async function handleLibrary(request: Request, deps: AppDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    let query;
    try { query = parseLibraryQuery(request); } catch { return failure(400); }
    return Response.json(await deps.storeFor(session).library(query.before, query.limit), { headers });
  } catch { return failure(503); }
}
export async function handleNarration(request: Request, captureId: string, deps: AppDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    if (!validId(captureId)) return failure(404);
    const result = await deps.storeFor(session).narration(captureId);
    if (!result) return failure(404);
    if ("status" in result) return Response.json(result, { status: 409, headers });
    return Response.json(result, { headers: { ...headers, ETag: `"${result.textVersion}"` } });
  } catch { return failure(503); }
}
