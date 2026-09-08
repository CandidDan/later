import { Webhook } from "standardwebhooks";

import {
  normalizeCaptureInput,
  type NormalizedCapture,
  type ProviderNeutralCaptureInput,
} from "../capture/normalize";
import type { JsonValue, PersistCaptureInput, PersistCaptureResult } from "../capture/persist";
import type { EmailWebhookConfiguration } from "./config";
import {
  EMAIL_CHANNEL,
  isAddressedToToken,
  parseReceivedEmailEvent,
  toCaptureInput,
} from "./event";

/**
 * The only body this endpoint ever returns. A sender who guesses the address must not be able
 * to tell an accepted capture from a rejected one, so "delivered but not for us", "not an
 * inbound message" and "captured" are one indistinguishable response.
 */
const ACKNOWLEDGEMENT = "Accepted";

export type VerifyEmailSignature = (
  payload: string,
  headers: Record<string, string>,
  secret: string,
) => unknown;

export interface EmailWebhookDependencies {
  configuration: EmailWebhookConfiguration;
  persist: (input: PersistCaptureInput) => Promise<PersistCaptureResult>;
  normalize?: (input: ProviderNeutralCaptureInput) => NormalizedCapture;
  verifySignature?: VerifyEmailSignature;
  now?: () => Date;
}

function plainText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Resend signs with the Standard Webhooks scheme and sends it under `svix-*` header names.
 * The signed message covers the id and timestamp as well as the body, so all three are
 * handed to the verifier untouched — a re-serialized body would not verify.
 */
const defaultVerifySignature: VerifyEmailSignature = (payload, headers, secret) =>
  new Webhook(secret).verify(payload, headers);

function signatureHeaders(request: Request): Record<string, string> | undefined {
  const header = (name: string) =>
    request.headers.get(`svix-${name}`) ?? request.headers.get(`webhook-${name}`);
  const id = header("id");
  const timestamp = header("timestamp");
  const signature = header("signature");

  if (!id || !timestamp || !signature) return undefined;

  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
}

/**
 * Accept one signed `email.received` event.
 *
 * The order is deliberate and is the whole security posture of the route: verify the raw body,
 * then decide whether the message was addressed to us, then persist. Nothing before a valid
 * signature parses the payload, and nothing in this request talks to Resend or to a model —
 * the acknowledgement means "durably captured and queued", which is all Resend needs to know.
 */
export async function handleInboundEmailWebhook(
  request: Request,
  dependencies: EmailWebhookDependencies,
): Promise<Response> {
  const { configuration } = dependencies;

  if (Object.values(configuration).some((value) => value.trim().length === 0)) {
    return plainText("Webhook is not configured", 500);
  }

  const headers = signatureHeaders(request);
  if (!headers) return plainText("Invalid signature", 403);

  let body: string;
  try {
    body = await request.text();
  } catch {
    return plainText("Invalid payload", 400);
  }

  const verify = dependencies.verifySignature ?? defaultVerifySignature;
  let payload: unknown;
  try {
    // Throws on a bad signature and on a timestamp outside the replay window alike.
    payload = verify(body, headers, configuration.webhookSecret);
  } catch {
    return plainText("Invalid signature", 403);
  }

  // Some verifiers return the parsed payload, others return nothing useful. Parse the raw body
  // ourselves when needed rather than trusting the verifier's return shape.
  if (payload === null || typeof payload !== "object") {
    try {
      payload = JSON.parse(body);
    } catch {
      return plainText("Invalid payload", 400);
    }
  }

  const event = parseReceivedEmailEvent(payload);

  if (!event || !isAddressedToToken(event, configuration.inboundToken)) {
    return plainText(ACKNOWLEDGEMENT, 200);
  }

  const normalize = dependencies.normalize ?? normalizeCaptureInput;
  const capturedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const input = toCaptureInput(event, payload as JsonValue, capturedAt);
  const capture = normalize(input);

  await dependencies.persist({
    userId: configuration.captureUserId,
    capture: {
      ...capture,
      channel: EMAIL_CHANNEL,
      capturedAt,
      rawProviderPayload: input.rawProviderPayload,
    },
  });

  return plainText(ACKNOWLEDGEMENT, 200);
}

export { ACKNOWLEDGEMENT };
