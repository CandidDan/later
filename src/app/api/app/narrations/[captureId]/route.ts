import { handleNarration } from "@/lib/app/handler";
import { createAppDependencies } from "@/lib/app/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ captureId: string }> }): Promise<Response> {
  return handleNarration(request, (await context.params).captureId, createAppDependencies());
}
