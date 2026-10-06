import { handleAction } from "@/lib/revisit/handler";
import { createRevisitDependencies } from "@/lib/revisit/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ captureId: string }> }): Promise<Response> {
  return handleAction(request, (await context.params).captureId, createRevisitDependencies());
}
