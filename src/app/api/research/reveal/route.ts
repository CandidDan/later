import { handleResearchEnrichment } from "@/lib/research/enrichment";
import { createResearchEnrichmentDependencies } from "@/lib/research/enrichment-server";
import { handleReveal } from "@/lib/research/handler";
import { createResearchDependencies } from "@/lib/research/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  if (query.get("view") === "card" || query.get("view") === "asset") {
    return handleResearchEnrichment(request, query.get("captureId") ?? "", query.get("view") === "asset" ? query.get("assetId") ?? "" : undefined, createResearchEnrichmentDependencies());
  }
  return handleReveal(request, createResearchDependencies());
}
