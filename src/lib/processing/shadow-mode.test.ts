import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Simulates intent processing being unavailable in the hardest possible way: constructing the
 * Anthropic client throws. If the acknowledgement path touched intent processing at all, these
 * tests would fail rather than quietly degrade.
 */
const anthropicConstructed = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      anthropicConstructed();
      throw new Error("Anthropic is unavailable");
    }
  },
}));

const { handleWhatsAppWebhook } = await import("../twilio/webhook");

function inboundRequest(): Request {
  const body = new FormData();
  body.set("Body", "https://www.youtube.com/watch?v=abc");
  body.set("MessageSid", "SM-ack-1");
  body.set("NumMedia", "0");

  return new Request("https://later.example/api/inbound/whatsapp", {
    method: "POST",
    headers: { "x-twilio-signature": "signature" },
    body,
  });
}

function sourceOf(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("intent processing stays out of the capture acknowledgement path", () => {
  it("AC7 acknowledges and persists a capture while intent processing is unavailable", async () => {
    const persisted: unknown[] = [];

    const response = await handleWhatsAppWebhook(inboundRequest(), {
      configuration: {
        authToken: "token",
        publicWebhookUrl: "https://later.example/api/inbound/whatsapp",
        captureUserId: "user-1",
      },
      validateSignature: () => true,
      persist: async (input) => {
        persisted.push(input);
        return { captureId: "capture-1", intentJobId: "job-1", created: true };
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Saved for Later");
    expect(persisted).toHaveLength(1);
    expect(anthropicConstructed).not.toHaveBeenCalled();
  });

  it("AC7 keeps the acknowledgement path free of any intent-processing import", () => {
    const acknowledgementSources = [
      "src/app/api/inbound/whatsapp/route.ts",
      "src/lib/twilio/webhook.ts",
      "src/lib/capture/persist.ts",
      "src/lib/capture/server.ts",
      "src/lib/capture/normalize.ts",
    ].map(sourceOf);

    for (const source of acknowledgementSources) {
      expect(source).not.toMatch(/@anthropic-ai\/sdk|lib\/processing|\.\.\/processing|\.\/processing/u);
    }
  });

  it("AC7 confines intent analysis to the job-processing route", () => {
    const jobsRoute = sourceOf("src/app/api/jobs/process/route.ts");
    const inboundRoute = sourceOf("src/app/api/inbound/whatsapp/route.ts");

    expect(jobsRoute).toContain("processNextIntentJob");
    expect(inboundRoute).not.toContain("processNextIntentJob");
  });

  it("AC7 exposes no analysis result in any user-facing page", () => {
    for (const page of ["src/app/page.tsx", "src/app/layout.tsx"]) {
      expect(sourceOf(page)).not.toMatch(/capture_analyses|intentResult|resolutionRequired/u);
    }
  });
});
