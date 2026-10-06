import { handleAsset } from "@/lib/revisit/handler";
import { createRevisitDependencies } from "@/lib/revisit/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ captureId: string; assetId: string }> }): Promise<Response> {
  const { captureId, assetId } = await context.params;
  return handleAsset(request, captureId, assetId, createRevisitDependencies());
}
