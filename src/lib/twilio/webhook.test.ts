import twilio from "twilio";
import { describe, expect, it, vi } from "vitest";

import { normalizeCaptureInput, type NormalizedCapture } from "../capture/normalize";
import type { PersistCaptureInput, PersistCaptureResult } from "../capture/persist";
import {
  ACKNOWLEDGEMENT,
  handleWhatsAppWebhook,
  type WhatsAppWebhookDependencies,
} from "./webhook";

const AUTH_TOKEN = "test-auth-token";
const PUBLIC_URL = "https://later.example/api/inbound/whatsapp";
const CAPTURE_USER_ID = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-09-03T02:15:00Z");
const TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Saved for Later ✓</Message></Response>';

function signature(parameters: Record<string, string>, url = PUBLIC_URL): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, parameters);
}

function webhookRequest(
  parameters: Record<string, string>,
  options: { signature?: string | null; internalUrl?: string; headers?: HeadersInit } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/x-www-form-urlencoded");
  if (options.signature !== null) {
    headers.set("x-twilio-signature", options.signature ?? signature(parameters));
  }

  return new Request(
    options.internalUrl ?? "http://whatsapp-service.internal/api/inbound/whatsapp",
    { method: "POST", headers, body: new URLSearchParams(parameters) },
  );
}

function dependencies(
  overrides: Partial<WhatsAppWebhookDependencies> = {},
): WhatsAppWebhookDependencies {
  return {
    configuration: {
      authToken: AUTH_TOKEN,
      publicWebhookUrl: PUBLIC_URL,
      captureUserId: CAPTURE_USER_ID,
    },
    persist: vi.fn(async () => ({
      captureId: "capture-1",
      intentJobId: "job-1",
      created: true,
    })),
    now: () => NOW,
    ...overrides,
  };
}

describe("POST /api/inbound/whatsapp", () => {
  it.each([
    ["missing", null],
    ["invalid", "not-a-valid-signature"],
  ])(
    "AC1 rejects a %s Twilio signature before normalization or persistence",
    async (_case, suppliedSignature) => {
      const normalize = vi.fn(normalizeCaptureInput);
      const persist = vi.fn<WhatsAppWebhookDependencies["persist"]>();
      const response = await handleWhatsAppWebhook(
        webhookRequest(
          { MessageSid: "SM-invalid", Body: "private message", NumMedia: "0" },
          { signature: suppliedSignature },
        ),
        dependencies({ normalize, persist }),
      );

      expect(response.status).toBe(403);
      expect(normalize).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["text", "remember this"],
    ["URL", "https://example.com/article"],
  ])(
    "AC2 accepts a valid signed %s message only after durable persistence",
    async (_kind, body) => {
      const events: string[] = [];
      let captured: PersistCaptureInput | undefined;
      const persist = vi.fn(async (input: PersistCaptureInput): Promise<PersistCaptureResult> => {
        events.push("persisted");
        captured = input;
        return { captureId: "capture-1", intentJobId: "job-1", created: true };
      });
      const parameters = {
        MessageSid: `SM-${_kind}`,
        Body: body,
        From: "whatsapp:+15551234567",
        To: "whatsapp:+15557654321",
        WaId: "15551234567",
        ProfileName: "Ada",
        NumMedia: "0",
      };

      const response = await handleWhatsAppWebhook(
        webhookRequest(parameters),
        dependencies({ persist }),
      );
      events.push("responded");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/xml; charset=utf-8");
      expect(await response.text()).toBe(TWIML);
      expect(events).toEqual(["persisted", "responded"]);
      expect(captured?.capture.externalMessageId).toBe(parameters.MessageSid);
      expect(captured?.capture.rawProviderPayload).toEqual(parameters);
      expect(captured?.capture.rawText).toBe(body);
    },
  );

  it("AC3 passes every declared media URL, MIME type, and provider index without downloading", async () => {
    let capture: NormalizedCapture | undefined;
    const normalize = vi.fn((input: Parameters<typeof normalizeCaptureInput>[0]) => {
      capture = normalizeCaptureInput(input);
      return capture;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const parameters = {
      MessageSid: "SM-media",
      Body: "two originals",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/media/ME1",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "https://api.twilio.com/media/ME2",
      MediaContentType1: "video/mp4",
    };

    const response = await handleWhatsAppWebhook(
      webhookRequest(parameters),
      dependencies({ normalize }),
    );

    expect(response.status).toBe(200);
    expect(capture?.attachments).toEqual([
      { url: parameters.MediaUrl0, contentType: "image/jpeg", providerIndex: 0 },
      { url: parameters.MediaUrl1, contentType: "video/mp4", providerIndex: 1 },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("AC4 acknowledges repeated MessageSid deliveries while persistence retains one capture and job", async () => {
    const captures = new Map<string, PersistCaptureResult>();
    let captureWrites = 0;
    let jobWrites = 0;
    const persist = vi.fn(async ({ capture }: PersistCaptureInput) => {
      const key = `${capture.channel}:${capture.externalMessageId}`;
      const existing = captures.get(key);
      if (existing) return { ...existing, created: false };

      captureWrites += 1;
      jobWrites += 1;
      const created = { captureId: "capture-1", intentJobId: "job-1", created: true };
      captures.set(key, created);
      return created;
    });
    const parameters = { MessageSid: "SM-retry", Body: "save once", NumMedia: "0" };

    const first = await handleWhatsAppWebhook(
      webhookRequest(parameters),
      dependencies({ persist }),
    );
    const retry = await handleWhatsAppWebhook(
      webhookRequest(parameters),
      dependencies({ persist }),
    );

    expect([first.status, retry.status]).toEqual([200, 200]);
    expect([await first.text(), await retry.text()]).toEqual([TWIML, TWIML]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect({ captureWrites, jobWrites }).toEqual({ captureWrites: 1, jobWrites: 1 });
  });

  it("AC5 completes acknowledgement without AI, source, submitted-URL, or media network work", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const parameters = {
      MessageSid: "SM-critical-path",
      Body: "https://example.com/private",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.com/media/ME-private",
      MediaContentType0: "image/png",
    };

    const response = await handleWhatsAppWebhook(
      webhookRequest(parameters),
      dependencies(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<Message>${ACKNOWLEDGEMENT}</Message>`);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("AC6 validates against configured public URL despite internal and forwarded hosts", async () => {
    const validateSignature = vi.fn(() => true);
    const parameters = { MessageSid: "SM-proxy", Body: "proxied", NumMedia: "0" };
    const response = await handleWhatsAppWebhook(
      webhookRequest(parameters, {
        internalUrl: "http://twilio-webhook.default.svc.cluster.local/inbound",
        headers: {
          host: "twilio-webhook.default.svc.cluster.local",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
      }),
      dependencies({ validateSignature }),
    );

    expect(response.status).toBe(200);
    expect(validateSignature).toHaveBeenCalledWith(
      AUTH_TOKEN,
      signature(parameters),
      PUBLIC_URL,
      parameters,
    );
  });
});
