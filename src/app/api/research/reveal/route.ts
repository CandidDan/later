import { handleReveal } from "@/lib/research/handler";
import { createResearchDependencies } from "@/lib/research/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleReveal(request, createResearchDependencies());
}
