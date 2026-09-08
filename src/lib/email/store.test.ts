import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { EmailError, configuredEmailRetrieval, configuredEmailWebhook } from "./config";
import { createEmailEnrichmentStore } from "./store";

function queryBuilder(outcome: { data: unknown; error: { message: string } | null }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve(outcome),
    maybeSingle: () => Promise.resolve(outcome),
  };
  return builder;
}

function client(overrides: {
  rpc?: ReturnType<typeof vi.fn>;
  captures?: { data: unknown; error: { message: string } | null };
  assets?: { data: unknown; error: { message: string } | null };
}) {
  return {
    rpc: overrides.rpc ?? vi.fn(async () => ({ data: null, error: null })),
    from: (table: string) =>
      queryBuilder(
        (table === "captures" ? overrides.captures : overrides.assets) ?? { data: null, error: null },
      ),
    storage: { from: () => ({ download: vi.fn(), upload: vi.fn() }) },
  } as unknown as SupabaseClient;
}

const job = { id: "job-1", captureId: "capture-1", attempts: 1 };

describe("email enrichment store", () => {
  it("claims a job and reads back its identity", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ id: "job-1", capture_id: "capture-1", attempts: 2 }],
      error: null,
    }));

    const store = createEmailEnrichmentStore(client({ rpc }), 1024);

    expect(await store.claim()).toEqual({ id: "job-1", captureId: "capture-1", attempts: 2 });
    expect(rpc).toHaveBeenCalledWith("claim_email_enrichment_job");
  });

  it("reports an empty queue rather than inventing a job", async () => {
    const store = createEmailEnrichmentStore(
      client({ rpc: vi.fn(async () => ({ data: [], error: null })) }),
      1024,
    );

    expect(await store.claim()).toBeUndefined();
  });

  it("AC5 reads the Resend email id from the capture's own idempotency key", async () => {
    const store = createEmailEnrichmentStore(
      client({ captures: { data: { external_message_id: "resend-email-1" }, error: null } }),
      1024,
    );

    expect(await store.loadEmailId("capture-1")).toBe("resend-email-1");
  });

  it("AC5 carries each asset's capture-time role and provider attachment id", async () => {
    const store = createEmailEnrichmentStore(
      client({
        assets: {
          data: [
            {
              id: "asset-1",
              capture_id: "capture-1",
              storage_path: "captures/u/c/1-email.json",
              media_type: "application/json",
              storage_state: "pending",
              metadata: { role: "email_representation" },
            },
            {
              id: "asset-2",
              capture_id: "capture-1",
              storage_path: "captures/u/c/2-brief.pdf",
              media_type: "application/pdf",
              storage_state: "stored",
              metadata: { role: "email_attachment", id: "att-1" },
            },
            {
              id: "asset-3",
              capture_id: "capture-1",
              storage_path: "captures/u/c/3-other",
              media_type: null,
              storage_state: "pending",
              metadata: { role: "smuggled" },
            },
          ],
          error: null,
        },
      }),
      1024,
    );

    const assets = await store.loadAssets("capture-1");

    expect(assets.map((asset) => asset.role)).toEqual([
      "email_representation",
      "email_attachment",
      // An unrecognised role is never silently promoted to one this code acts on.
      "unknown",
    ]);
    expect(assets[1].providerAttachmentId).toBe("att-1");
    expect(assets[0].providerAttachmentId).toBeNull();
  });

  it.each<[string, { mediaType: string; byteSize: number; sha256: string } | null, string | undefined]>([
    ["an asset", { mediaType: "application/pdf", byteSize: 1, sha256: "a".repeat(64) }, undefined],
    ["a failed asset", null, "unsafe_media"],
  ])("fences %s finalization on the claimed attempt", async (_name, evidence, errorCode) => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createEmailEnrichmentStore(client({ rpc }), 1024);

    const asset = {
      id: "asset-1",
      captureId: "capture-1",
      storagePath: "p",
      role: "email_attachment",
      providerAttachmentId: "att-1",
      mediaType: null,
      storageState: "pending",
    };

    expect(await store.finishAsset(job, asset, evidence, errorCode)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("finish_email_asset", {
      p_job_id: "job-1",
      p_attempt: 1,
      p_asset_id: "asset-1",
      p_evidence: evidence,
      p_error_code: errorCode ?? null,
    });
  });

  it("fences the attempt itself and passes a safe code through", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = createEmailEnrichmentStore(client({ rpc }), 1024);

    await store.finish(job, "email_missing");

    expect(rpc).toHaveBeenCalledWith("finish_email_enrichment_attempt", {
      p_job_id: "job-1",
      p_attempt: 1,
      p_error_code: "email_missing",
    });
  });

  it.each([
    ["claim", (s: ReturnType<typeof createEmailEnrichmentStore>) => s.claim()],
    ["finish", (s: ReturnType<typeof createEmailEnrichmentStore>) => s.finish(job)],
  ])("AC6 turns a database failure into a retryable code, never its message", async (_name, call) => {
    const store = createEmailEnrichmentStore(
      client({ rpc: vi.fn(async () => ({ data: null, error: { message: "relation secret_table" } })) }),
      1024,
    );

    await expect(call(store)).rejects.toMatchObject({ code: "email_unavailable" });
  });

  it("AC6 turns a failed capture or asset read into a retryable code", async () => {
    const store = createEmailEnrichmentStore(
      client({
        captures: { data: null, error: { message: "boom" } },
        assets: { data: null, error: { message: "boom" } },
      }),
      1024,
    );

    await expect(store.loadEmailId("capture-1")).rejects.toMatchObject({ code: "email_unavailable" });
    await expect(store.loadAssets("capture-1")).rejects.toMatchObject({ code: "email_unavailable" });
  });
});

describe("inbound email configuration", () => {
  it("reads the webhook configuration without ever needing an API key", () => {
    expect(
      configuredEmailWebhook({
        RESEND_WEBHOOK_SECRET: "whsec_test",
        EMAIL_INBOUND_TOKEN: "capture",
        EMAIL_CAPTURE_USER_ID: "user-1",
        RESEND_API_KEY: "re_TEST-ONLY-NOT-A-CREDENTIAL",
      }),
    ).toEqual({ webhookSecret: "whsec_test", inboundToken: "capture", captureUserId: "user-1" });
  });

  it("reports missing webhook configuration as empty rather than throwing", () => {
    expect(configuredEmailWebhook({})).toEqual({
      webhookSecret: "",
      inboundToken: "",
      captureUserId: "",
    });
  });

  it("defaults the retrieval bounds and base URL", () => {
    expect(configuredEmailRetrieval({ RESEND_API_KEY: "re_TEST-ONLY-NOT-A-CREDENTIAL" })).toEqual({
      apiKey: "re_TEST-ONLY-NOT-A-CREDENTIAL",
      apiBaseUrl: "https://api.resend.com",
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it.each([
    ["no API key", {}],
    ["a blank API key", { RESEND_API_KEY: "  " }],
    ["a plaintext base URL", { RESEND_API_KEY: "re_x", RESEND_API_BASE_URL: "http://api.resend.com" }],
    ["a base URL with a path", { RESEND_API_KEY: "re_x", RESEND_API_BASE_URL: "https://api.resend.com/v1" }],
    ["a zero byte ceiling", { RESEND_API_KEY: "re_x", EMAIL_MAX_BYTES: "0" }],
    ["a ceiling above 20 MiB", { RESEND_API_KEY: "re_x", EMAIL_MAX_BYTES: "20971521" }],
    ["a non-numeric ceiling", { RESEND_API_KEY: "re_x", EMAIL_MAX_BYTES: "lots" }],
  ])("refuses retrieval configuration with %s", (_name, env) => {
    expect(() => configuredEmailRetrieval(env)).toThrow(EmailError);
  });
});
