import { describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";

import type { PersistCaptureInput, PersistCaptureResult } from "../capture/persist";
import { ACKNOWLEDGEMENT, handleInboundEmailWebhook } from "./webhook";

// A local, disposable signing key. Never a real credential.
const SECRET = `whsec_${Buffer.from("inbound-email-test-only-secret").toString("base64")}`;
const TOKEN = "capture";
const USER_ID = "11111111-2222-3333-4444-555555555555";

const configuration = { webhookSecret: SECRET, inboundToken: TOKEN, captureUserId: USER_ID };

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    created_at: "2026-09-08T10:00:00.000Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      message_id: "<111-222-333@mail.example.com>",
      from: "newsletter@example.com",
      to: ["capture@later.resend.app"],
      cc: [],
      bcc: [],
      subject: "Worth reading: https://example.com/article",
      attachments: [
        { id: "att-1", filename: "brief.pdf", content_type: "application/pdf", content_id: null },
      ],
      ...overrides,
    },
  };
}

function signedRequest(
  payload: unknown,
  options: { id?: string; timestamp?: Date; secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  const id = options.id ?? "msg_test_1";
  const timestamp = options.timestamp ?? new Date();
  const signature =
    options.signature ?? new Webhook(options.secret ?? SECRET).sign(id, timestamp, body);

  return new Request("https://test.invalid/api/inbound/email", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
  });
}

function dependencies() {
  const persisted: PersistCaptureInput[] = [];
  const normalized: unknown[] = [];
  const persist = vi.fn(async (input: PersistCaptureInput): Promise<PersistCaptureResult> => {
    persisted.push(input);
    return { captureId: "capture-1", intentJobId: "job-1", created: true };
  });

  return { persisted, normalized, persist };
}

describe("inbound email webhook", () => {
  it("AC1 rejects a missing signature before reading or persisting anything", async () => {
    const { persist } = dependencies();
    const body = JSON.stringify(event());
    const request = new Request("https://test.invalid/api/inbound/email", { method: "POST", body });
    const readBody = vi.spyOn(request, "text");

    const response = await handleInboundEmailWebhook(request, { configuration, persist });

    expect(response.status).toBe(403);
    expect(readBody).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid signature", { signature: "v1,ZGVmaW5pdGVseS1ub3QtdGhlLXNpZ25hdHVyZQ==" }],
    ["a signature from another secret", { secret: `whsec_${Buffer.from("other-secret").toString("base64")}` }],
    ["an expired timestamp", { timestamp: new Date(Date.now() - 60 * 60 * 1000) }],
  ])("AC1 rejects %s and performs no normalization, persistence or fetch", async (_name, options) => {
    const { persist } = dependencies();
    const normalize = vi.fn();
    const fetcher = vi.spyOn(globalThis, "fetch");

    const response = await handleInboundEmailWebhook(signedRequest(event(), options), {
      configuration,
      persist,
      normalize,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Invalid signature");
    expect(normalize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it("AC1 rejects a body edited after signing", async () => {
    const { persist } = dependencies();
    const original = JSON.stringify(event());
    const id = "msg_test_tamper";
    const timestamp = new Date();
    const request = new Request("https://test.invalid/api/inbound/email", {
      method: "POST",
      body: original.replace("Worth reading", "Worth reading!"),
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(SECRET).sign(id, timestamp, original),
      },
    });

    expect((await handleInboundEmailWebhook(request, { configuration, persist })).status).toBe(403);
    expect(persist).not.toHaveBeenCalled();
  });

  it("AC2 captures one lossless email and queues enrichment before any Resend request", async () => {
    const { persist, persisted } = dependencies();
    const fetcher = vi.spyOn(globalThis, "fetch");

    const response = await handleInboundEmailWebhook(signedRequest(event()), {
      configuration,
      persist,
      now: () => new Date("2026-09-08T10:00:05.000Z"),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ACKNOWLEDGEMENT);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();

    const [{ userId, capture }] = persisted;
    expect(userId).toBe(USER_ID);
    expect(capture.channel).toBe("email");
    expect(capture.kind).toBe("email");
    expect(capture.externalMessageId).toBe("56761188-7520-42d8-8898-ff6fc54ce618");
    expect(capture.capturedAt).toBe("2026-09-08T10:00:05.000Z");

    // Lossless: the signed event, its identifiers, envelope, attachment metadata and URLs.
    const payload = capture.rawProviderPayload as Record<string, unknown>;
    expect(payload.event).toEqual(event());
    expect(payload.messageId).toBe("<111-222-333@mail.example.com>");
    expect(payload.from).toBe("newsletter@example.com");
    expect(payload.to).toEqual(["capture@later.resend.app"]);
    expect(payload.urls).toEqual(["https://example.com/article"]);
    expect(payload.attachments).toEqual([
      { id: "att-1", filename: "brief.pdf", contentType: "application/pdf" },
    ]);

    // One asset for the parsed representation the enrichment job will fill, one per attachment.
    expect(capture.attachments?.map((asset) => asset.role)).toEqual([
      "email_representation",
      "email_attachment",
    ]);
    expect(capture.attachments?.[1].id).toBe("att-1");
    // A temporary provider download URL is never part of durable capture data.
    expect(JSON.stringify(capture)).not.toMatch(/download_url|downloadUrl/u);
  });

  it("AC2 keeps every URL of the message in encounter order", async () => {
    const { persist, persisted } = dependencies();
    await handleInboundEmailWebhook(
      signedRequest(event({ subject: "https://b.example/2 then https://a.example/1 then https://b.example/2" })),
      { configuration, persist },
    );

    expect((persisted[0].capture.rawProviderPayload as Record<string, unknown>).urls).toEqual([
      "https://b.example/2",
      "https://a.example/1",
      "https://b.example/2",
    ]);
  });

  it.each([
    ["a different local part", ["someone-else@later.resend.app"]],
    ["a token-like domain only", ["hello@capture.example.com"]],
    ["a malformed address", ["capture"]],
  ])("AC3 creates no capture for %s and reveals nothing", async (_name, to) => {
    const { persist } = dependencies();
    const normalize = vi.fn();

    const response = await handleInboundEmailWebhook(signedRequest(event({ to })), {
      configuration,
      persist,
      normalize,
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(ACKNOWLEDGEMENT);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(USER_ID);
    expect(normalize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["the To header", { to: ["capture@later.resend.app"] }],
    ["a +tagged address", { to: ["capture+newsletters@later.resend.app"] }],
    ["a display-name address", { to: ["Later <Capture@later.resend.app>"] }],
    ["Cc", { to: ["someone@example.com"], cc: ["capture@later.resend.app"] }],
    ["the forwarding for clause", { to: ["list@example.com"], received_for: ["capture@later.resend.app"] }],
  ])("AC3 accepts mail addressed via %s", async (_name, overrides) => {
    const { persist } = dependencies();
    await handleInboundEmailWebhook(signedRequest(event(overrides)), { configuration, persist });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("AC4 hands a replayed email id the same idempotency key under a new delivery id", async () => {
    const { persist, persisted } = dependencies();
    const payload = event();

    await handleInboundEmailWebhook(signedRequest(payload, { id: "msg_delivery_1" }), {
      configuration,
      persist,
    });
    await handleInboundEmailWebhook(signedRequest(payload, { id: "msg_delivery_2" }), {
      configuration,
      persist,
    });

    expect(persisted).toHaveLength(2);
    expect(persisted[0].capture.externalMessageId).toBe(persisted[1].capture.externalMessageId);
    expect(persisted[0].userId).toBe(persisted[1].userId);
    expect(persisted[0].capture.channel).toBe(persisted[1].capture.channel);
  });

  it("acknowledges an event type it does not capture without persisting", async () => {
    const { persist } = dependencies();
    const response = await handleInboundEmailWebhook(
      signedRequest({ type: "email.delivered", data: { email_id: "other" } }),
      { configuration, persist },
    );

    expect(response.status).toBe(200);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["no webhook secret", { webhookSecret: "" }],
    ["no inbound token", { inboundToken: "" }],
    ["no capture user", { captureUserId: "" }],
  ])("fails closed with %s", async (_name, overrides) => {
    const { persist } = dependencies();
    const response = await handleInboundEmailWebhook(signedRequest(event()), {
      configuration: { ...configuration, ...overrides },
      persist,
    });

    expect(response.status).toBe(500);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects a signed body that is not JSON", async () => {
    const { persist } = dependencies();
    const id = "msg_not_json";
    const timestamp = new Date();
    const body = "not json";
    const request = new Request("https://test.invalid/api/inbound/email", {
      method: "POST",
      body,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(SECRET).sign(id, timestamp, body),
      },
    });

    const response = await handleInboundEmailWebhook(request, {
      configuration,
      persist,
      verifySignature: () => undefined,
    });

    expect(response.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });
});
