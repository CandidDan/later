import { persistCapture } from "@/lib/capture/server";
import { configuredEmailWebhook } from "@/lib/email/config";
import { handleInboundEmailWebhook } from "@/lib/email/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleInboundEmailWebhook(request, {
      configuration: configuredEmailWebhook(),
      persist: persistCapture,
    });
  } catch {
    return new Response("Capture could not be saved", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
