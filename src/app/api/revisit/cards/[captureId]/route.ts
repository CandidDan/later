import { handleCard } from "@/lib/revisit/handler";
import { createRevisitDependencies } from "@/lib/revisit/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ captureId: string }> }): Promise<Response> {
  return handleCard(request, (await context.params).captureId, createRevisitDependencies());
}
