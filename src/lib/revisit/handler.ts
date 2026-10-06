import { isImageType, validateMedia } from "../assets/media";
import type { ResearchSession } from "../research/types";
import type { RevisitStore } from "./store";
export interface RevisitDependencies {
  authenticate(request: Request): Promise<ResearchSession | undefined>;
  storeFor(session: ResearchSession): RevisitStore;
}
const headers = { "Cache-Control": "private, no-store", "Vary": "Authorization", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) => Response.json({ error: status === 401 ? "Unauthorized" : "Unavailable" }, { status, headers });
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export async function handleCard(request: Request, captureId: string, deps: RevisitDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    if (!validId(captureId)) return failure(404);
    const card = await deps.storeFor(session).card(captureId);
    return card ? Response.json(card, { headers }) : failure(404);
  } catch { return failure(503); }
}
export async function handleAsset(request: Request, captureId: string, assetId: string, deps: RevisitDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    if (!validId(captureId) || !validId(assetId)) return failure(404);
    const asset = await deps.storeFor(session).asset(captureId, assetId);
    if (!asset) return failure(404);
    const inline = new URL(request.url).searchParams.get("download") !== "1";
    let mediaType = "application/octet-stream";
    if (inline) {
      if (!isImageType(asset.mediaType) || asset.bytes.size > 20 * 1024 * 1024) return failure(415);
      mediaType = validateMedia(Buffer.from(await asset.bytes.arrayBuffer()), asset.mediaType, asset.mediaType, 20 * 1024 * 1024).mediaType;
    }
    const filename = encodeURIComponent(asset.filename.replace(/[\r\n]/g, ""));
    return new Response(asset.bytes, { headers: { ...headers, "Content-Type": mediaType, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`, "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch { return failure(503); }
}

export async function handleBatch(request: Request, deps: RevisitDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    const cards = await deps.storeFor(session).batch();
    return Response.json({ status: cards.length ? "available" : "empty", cards }, { headers });
  } catch { return failure(503); }
}
export async function handleAction(request: Request, captureId: string, deps: RevisitDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);
    if (!validId(captureId)) return failure(404);
    let input;
    try { input = await request.json(); } catch { return failure(400); }
    if (!input || typeof input.requestId !== "string" || !validId(input.requestId) || !["open", "defer", "consume"].includes(input.action)) return failure(400);
    const result = await deps.storeFor(session).action(captureId, input.requestId, input.action);
    return Response.json(result, { status: result.status === "unavailable" ? 409 : 200, headers });
  } catch { return failure(503); }
}
