import { handleBatch } from "@/lib/revisit/handler";
import { createRevisitDependencies } from "@/lib/revisit/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleBatch(request, createRevisitDependencies());
}
