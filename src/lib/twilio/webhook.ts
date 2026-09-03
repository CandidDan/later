import twilio from "twilio";

import {
  normalizeCaptureInput,
  type CaptureAttachment,
  type NormalizedCapture,
  type ProviderNeutralCaptureInput,
} from "../capture/normalize";
import type { PersistCaptureInput, PersistCaptureResult } from "../capture/persist";

const ACKNOWLEDGEMENT = "Saved for Later ✓";
const TWIML_ACKNOWLEDGEMENT =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Saved for Later ✓</Message></Response>';

export interface WhatsAppWebhookConfiguration {
  authToken: string;
  publicWebhookUrl: string;
  captureUserId: string;
}

export interface WhatsAppWebhookDependencies {
  configuration: WhatsAppWebhookConfiguration;
  normalize?: (input: ProviderNeutralCaptureInput) => NormalizedCapture;
  persist: (input: PersistCaptureInput) => Promise<PersistCaptureResult>;
  validateSignature?: (
    authToken: string,
    signature: string,
    publicWebhookUrl: string,
    parameters: Record<string, string>,
  ) => boolean;
  now?: () => Date;
}

function plainText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function requireConfiguration(configuration: WhatsAppWebhookConfiguration): boolean {
  return Object.values(configuration).every((value) => value.trim().length > 0);
}

function formParameters(formData: FormData): Record<string, string> | undefined {
  const parameters: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") return undefined;
    parameters[key] = value;
  }

  return parameters;
}

function parseMediaCount(parameters: Record<string, string>): number | undefined {
  const rawCount = parameters.NumMedia ?? "0";
  if (!/^\d+$/u.test(rawCount)) return undefined;

  const count = Number(rawCount);
  return Number.isSafeInteger(count) ? count : undefined;
}

function mediaAttachments(
  parameters: Record<string, string>,
  count: number,
): CaptureAttachment[] {
  return Array.from({ length: count }, (_, providerIndex) => ({
    ...(parameters[`MediaSid${providerIndex}`]
      ? { id: parameters[`MediaSid${providerIndex}`] }
      : {}),
    ...(parameters[`MediaContentType${providerIndex}`]
      ? { contentType: parameters[`MediaContentType${providerIndex}`] }
      : {}),
    ...(parameters[`MediaUrl${providerIndex}`]
      ? { url: parameters[`MediaUrl${providerIndex}`] }
      : {}),
    providerIndex,
  }));
}

export async function handleWhatsAppWebhook(
  request: Request,
  dependencies: WhatsAppWebhookDependencies,
): Promise<Response> {
  if (!requireConfiguration(dependencies.configuration)) {
    return plainText("Webhook is not configured", 500);
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return plainText("Invalid Twilio signature", 403);

  let parameters: Record<string, string> | undefined;
  try {
    parameters = formParameters(await request.formData());
  } catch {
    return plainText("Invalid form payload", 400);
  }

  if (!parameters) return plainText("Invalid form payload", 400);

  const validateSignature = dependencies.validateSignature ?? twilio.validateRequest;
  const valid = validateSignature(
    dependencies.configuration.authToken,
    signature,
    dependencies.configuration.publicWebhookUrl,
    parameters,
  );
  if (!valid) return plainText("Invalid Twilio signature", 403);

  const mediaCount = parseMediaCount(parameters);
  if (mediaCount === undefined) return plainText("Invalid media count", 400);

  const normalize = dependencies.normalize ?? normalizeCaptureInput;
  const capture = normalize({
    channel: "whatsapp",
    rawText: parameters.Body,
    externalMessageId: parameters.MessageSid,
    capturedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    rawProviderPayload: parameters,
    attachments: mediaAttachments(parameters, mediaCount),
  });

  await dependencies.persist({
    userId: dependencies.configuration.captureUserId,
    capture: {
      ...capture,
      channel: "whatsapp",
      capturedAt: capture.capturedAt!,
      rawProviderPayload: parameters,
    },
  });

  return new Response(TWIML_ACKNOWLEDGEMENT, {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

export { ACKNOWLEDGEMENT };
