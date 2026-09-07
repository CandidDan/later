import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { handleWhatsAppWebhook } from "../twilio/webhook";
import { createMediaStore } from "./store";
import { processNextMediaJob } from "./process";
import { digest } from "./media";
import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "../jobs/supabase-store";
import { processNextIntentJob } from "../processing/intent";
import type { IntentAnalyser } from "../processing/anthropic";
vi.mock("server-only", () => ({}));
const { persistCapture } = await import("../capture/persist");

// Opt-in real HTTP tests, deliberately restricted to the isolated local test stack.
// Run the configured pnpm test with LATER_MEDIA_LOCAL_ENV pointing to its `supabase status -o env` file.
const envFile = process.env.LATER_MEDIA_LOCAL_ENV;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
const audio = Buffer.from("#!AMR\noriginal unsupported audio");
const config = { accountSid: `AC${"a".repeat(32)}`, authToken: "TEST-ONLY-NOT-A-CREDENTIAL", maxBytes: 1024 };
const webhookUrl = "https://local-test.invalid/api/inbound/whatsapp";
const result: Awaited<ReturnType<IntentAnalyser>> = { modelId: "test-model", result: {
  contentType: "image", interest: { summary: "Saved image", confidence: 0.6 }, classification: { value: "reference", confidence: 0.6 },
  underlyingSource: { hints: [], confidence: 0.1 }, resolutionRequired: false,
  evidence: [{ field: "assets", observation: "captured attachment", weight: "primary" }],
} };

describe.skipIf(!envFile)("real private-media integration", () => {
  let admin: SupabaseClient, owner: SupabaseClient, other: SupabaseClient;
  let userId: string, otherId: string, captureId: string;
  let apiUrl: string;
  const objectPaths: string[] = [];
  beforeAll(async () => {
    const env = Object.fromEntries(readFileSync(envFile!, "utf8").split("\n").flatMap(line => {
      const m = /^([A-Z_]+)="(.*)"$/u.exec(line); return m ? [[m[1], m[2]]] : [];
    }));
    apiUrl = env.API_URL;
    if (apiUrl !== "http://127.0.0.1:55321") throw new Error("Tests require the isolated later0007 local stack");
    admin = createClient(apiUrl, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const users = await Promise.all([0, 1].map(async () => {
      const email = `media-${randomUUID()}@example.test`, password = randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      const client = createClient(apiUrl, env.ANON_KEY, { auth: { persistSession: false } });
      const signed = await client.auth.signInWithPassword({ email, password });
      if (signed.error) throw signed.error;
      return { client, id: created.data.user.id };
    }));
    owner = users[0].client; other = users[1].client; userId = users[0].id; otherId = users[1].id;
  }, 30_000);
  afterAll(async () => {
    if (objectPaths.length) await admin.storage.from("capture-assets").remove(objectPaths);
    if (userId) await admin.auth.admin.deleteUser(userId);
    if (otherId) await admin.auth.admin.deleteUser(otherId);
  });
  it("AC1 AC4 signed two-media webhook acknowledges before downloads and concurrent retries create one capture", async () => {
    const parameters = { Body: "saved media", MessageSid: `SM${randomUUID().replaceAll("-", "")}`, NumMedia: "2",
      MediaContentType0: "image/png", MediaContentType1: "audio/amr",
      MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages/SM${"b".repeat(32)}/Media/ME${"c".repeat(32)}`,
      MediaUrl1: `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages/SM${"b".repeat(32)}/Media/ME${"d".repeat(32)}` };
    const signature = twilio.getExpectedTwilioSignature(config.authToken, webhookUrl, parameters);
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const responses = await Promise.all([0, 1].map(() => handleWhatsAppWebhook(new Request(webhookUrl, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        body: new URLSearchParams(parameters),
      }), { configuration: { authToken: config.authToken, publicWebhookUrl: webhookUrl, captureUserId: userId },
        persist: input => persistCapture(input, admin) })));
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Saved for Later ✓</Message></Response>');
      }
      expect(network.mock.calls.every(([input]) => !String(input).includes("twilio.com"))).toBe(true);
    } finally { network.mockRestore(); }
    const { data: captures, error } = await admin.from("captures").select("id").eq("external_message_id", parameters.MessageSid);
    expect(error).toBeNull(); expect(captures).toHaveLength(1); captureId = captures![0].id;
    const assets = await admin.from("capture_assets").select("id").eq("capture_id", captureId);
    expect(assets.data).toHaveLength(2);
    const jobs = await admin.from("capture_jobs").select("asset_id,status").eq("capture_id", captureId).eq("job_type", "media_download");
    expect(jobs.data).toHaveLength(2); expect(jobs.data?.every(j => j.status === "pending")).toBe(true);
    expect(new Set(jobs.data?.map(j => j.asset_id)).size).toBe(2);
  });
  it("AC2 AC4 AC5 concurrently stores exact originals once and appends exactly one enriched run", async () => {
    const intentStore = createSupabaseCaptureJobStore(admin as unknown as CaptureJobTableClient);
    expect(await processNextIntentJob({ store: intentStore, analyse: async () => result })).toMatchObject({ status: "succeeded", captureId });
    const first = await admin.from("capture_analyses").select("*").eq("capture_id", captureId);
    const original = JSON.stringify(first.data);
    const store = createMediaStore(admin, config.maxBytes);
    const fetcher = vi.fn<typeof fetch>(async input => {
      const isImage = String(input).endsWith(`ME${"c".repeat(32)}`);
      return new Response(isImage ? png : audio, { headers: { "content-type": isImage ? "image/png" : "audio/amr" } });
    });
    const outcomes = await Promise.all([processNextMediaJob(store, config, fetcher), processNextMediaJob(store, config, fetcher), processNextMediaJob(store, config, fetcher)]);
    expect(outcomes.filter(o => o.status === "succeeded")).toHaveLength(2);
    expect(await processNextMediaJob(store, config, fetcher)).toEqual({ status: "idle" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const assets = await admin.from("capture_assets").select("*").eq("capture_id", captureId);
    for (const asset of assets.data!) {
      objectPaths.push(asset.storage_path);
      const expected = asset.media_type === "image/png" ? png : audio;
      expect(asset).toMatchObject({ storage_state: "stored", stored_byte_size: expected.length, sha256: digest(expected), observed_media_type: asset.media_type });
      expect(asset.stored_at).toBeTruthy(); expect(asset.metadata.url).toContain("api.twilio.com");
      const object = await admin.storage.from("capture-assets").download(asset.storage_path);
      expect(object.error).toBeNull(); expect(Buffer.from(await object.data!.arrayBuffer())).toEqual(expected);
      const identity = { id: asset.id, captureId, storagePath: asset.storage_path, providerUrl: asset.metadata.url, mediaType: asset.media_type };
      await store.put(identity, { bytes: expected, byteSize: expected.length, mediaType: asset.media_type, sha256: digest(expected) });
      await expect(store.put(identity, { bytes: Buffer.from("different bytes"), byteSize: 15, mediaType: asset.media_type, sha256: digest(Buffer.from("different bytes")) })).rejects.toThrow("storage_conflict");
    }
    const listing = await admin.storage.from("capture-assets").list(`captures/${userId}/${captureId}`);
    expect(listing.data).toHaveLength(2);
    const jobs = await admin.from("capture_jobs").select("*").eq("capture_id", captureId).eq("intent_phase", "enriched");
    expect(jobs.data).toHaveLength(1);
    const analysed = vi.fn<IntentAnalyser>(async () => result);
    const readImage = async (asset: import("../jobs/types").CaptureAssetRecord) => {
      const object = await admin.storage.from("capture-assets").download(asset.storagePath!);
      if (object.error) throw object.error; return Buffer.from(await object.data!.arrayBuffer());
    };
    const enriched = await Promise.all([processNextIntentJob({ store: intentStore, analyse: analysed, readImage }), processNextIntentJob({ store: intentStore, analyse: analysed, readImage })]);
    expect(enriched.filter(o => o.status === "succeeded")).toHaveLength(1);
    expect(analysed).toHaveBeenCalledTimes(1);
    expect(analysed.mock.calls[0][1]).toEqual([{ assetId: expect.any(String), mediaType: "image/png", data: png.toString("base64") }]);
    const unchanged = await admin.from("capture_analyses").select("*").eq("id", first.data![0].id);
    expect(JSON.stringify(unchanged.data)).toBe(original);
    const runs = await admin.from("capture_analyses").select("input_snapshot").eq("capture_id", captureId);
    expect(runs.data).toHaveLength(2);
    expect(JSON.stringify(runs.data)).not.toMatch(/api\.twilio|TEST-ONLY|iVBOR|storage_path/u);
  });
  it("AC7 owner reads exact bytes while the other user and unsigned public requests cannot", async () => {
    const path = objectPaths[0]; expect(path).toBeTruthy();
    const own = await owner.storage.from("capture-assets").download(path);
    expect(own.error).toBeNull(); expect(own.data!.size).toBeGreaterThan(0);
    const foreign = await other.storage.from("capture-assets").download(path);
    expect(foreign.data).toBeNull(); expect(foreign.error).not.toBeNull();
    const anonymous = await fetch(`${apiUrl}/storage/v1/object/capture-assets/${path}`);
    expect(anonymous.ok).toBe(false);
    const publicRequest = await fetch(`${apiUrl}/storage/v1/object/public/capture-assets/${path}`);
    expect(publicRequest.ok).toBe(false);
    const foreignMetadata = await other.from("capture_assets").select("*").eq("capture_id", captureId);
    expect(foreignMetadata.data).toEqual([]);
    const claim = await other.rpc("claim_media_job"); expect(claim.error).not.toBeNull();
  });
});
