import { handleAppCapture } from "@/lib/capture/app-share";
import { createAppShareDependencies } from "@/lib/capture/app-share-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return handleAppCapture(request, createAppShareDependencies());
}
