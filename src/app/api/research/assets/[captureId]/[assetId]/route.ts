import { handleResearchEnrichment } from "@/lib/research/enrichment";
import { createResearchEnrichmentDependencies } from "@/lib/research/enrichment-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ captureId: string; assetId: string }> }): Promise<Response> {
  const { captureId, assetId } = await context.params;
  return handleResearchEnrichment(request, captureId, assetId, createResearchEnrichmentDependencies());
}
