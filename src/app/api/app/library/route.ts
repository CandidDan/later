import { handleLibrary } from "@/lib/app/handler";
import { createAppDependencies } from "@/lib/app/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleLibrary(request, createAppDependencies());
}
