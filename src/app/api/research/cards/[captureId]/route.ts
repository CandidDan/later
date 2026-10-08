import { handleResearchEnrichment } from "@/lib/research/enrichment";
import { createResearchEnrichmentDependencies } from "@/lib/research/enrichment-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ captureId: string }> }): Promise<Response> {
  return handleResearchEnrichment(request, (await context.params).captureId, undefined, createResearchEnrichmentDependencies());
}
