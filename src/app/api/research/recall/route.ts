import { handleRecallSubmission } from "@/lib/research/handler";
import { createResearchDependencies } from "@/lib/research/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRecallSubmission(request, createResearchDependencies());
}
