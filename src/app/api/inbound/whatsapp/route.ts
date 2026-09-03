import { persistCapture } from "@/lib/capture/server";
import { handleWhatsAppWebhook } from "@/lib/twilio/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleWhatsAppWebhook(request, {
      configuration: {
        authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
        publicWebhookUrl: process.env.TWILIO_WEBHOOK_URL ?? "",
        captureUserId: process.env.TWILIO_CAPTURE_USER_ID ?? "",
      },
      persist: persistCapture,
    });
  } catch {
    return new Response("Capture could not be saved", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
