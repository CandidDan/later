import { describe, expect, it, vi } from "vitest";

import { digest, type DownloadedMedia, type MediaEvidence } from "../assets/media";
import type { EmailRetrievalConfiguration } from "./config";
import { processNextEmailEnrichmentJob } from "./enrich";
import { parseStoredRepresentation } from "./representation";
import type { EmailAsset, EmailEnrichmentJob, EmailEnrichmentStore } from "./store";

const config: EmailRetrievalConfiguration = {
  apiKey: "re_TEST-ONLY-NOT-A-CREDENTIAL",
  apiBaseUrl: "https://api.resend.com",
  maxBytes: 5 * 1024 * 1024,
};

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.7\nbody bytes", "utf8");

function asset(overrides: Partial<EmailAsset> & Pick<EmailAsset, "id" | "role">): EmailAsset {
  return {
    captureId: "capture-1",
    storagePath: `captures/user/capture-1/${overrides.id}`,
    providerAttachmentId: null,
    mediaType: null,
    storageState: "pending",
    ...overrides,
  };
}

const REPRESENTATION = asset({
  id: "asset-representation",
  role: "email_representation",
  mediaType: "application/json",
});

const emailResponse = {
  object: "email",
  id: EMAIL_ID,
  to: ["capture@later.resend.app"],
  from: "newsletter@example.com",
  created_at: "2026-09-08T10:00:00.000Z",
  subject: "Worth reading",
  text: "Read https://example.com/one and https://example.com/two",
  html: '<p>Read <a href="https://example.com/one">one</a></p>',
  html_format: "data_uri",
  headers: { "list-id": "<news.example.com>", from: "Example <newsletter@example.com>" },
  cc: [],
  bcc: [],
  reply_to: [],
  received_for: [],
  message_id: "<111-222-333@mail.example.com>",
  raw: {
    download_url: "https://inbound-cdn.resend.com/raw/secret-signature-do-not-store",
    expires_at: "2026-09-08T11:00:00.000Z",
  },
  attachments: [
    { id: "att-1", filename: "brief.pdf", content_type: "application/pdf", size: PDF.length },
    { id: "att-2", filename: "cover.png", content_type: "image/png", size: PNG.length },
  ],
};

const attachmentList = {
  object: "list",
  has_more: false,
  data: [
    {
      id: "att-1",
      filename: "brief.pdf",
      content_type: "application/pdf",
      size: PDF.length,
      download_url: "https://inbound-cdn.resend.com/att-1?signature=sig-1",
      expires_at: "2026-09-08T11:00:00.000Z",
    },
    {
      id: "att-2",
      filename: "cover.png",
      content_type: "image/png",
      size: PNG.length,
      download_url: "https://inbound-cdn.resend.com/att-2?signature=sig-2",
      expires_at: "2026-09-08T11:00:00.000Z",
    },
  ],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function binaryResponse(bytes: Buffer, contentType: string) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = Object.entries(routes).find(([key]) => url.includes(key));
    if (!route) return new Response("not found", { status: 404 });
    return route[1]();
  }) as unknown as typeof fetch;
}

const happyRoutes = {
  [`/emails/receiving/${EMAIL_ID}/attachments`]: () => jsonResponse(attachmentList),
  [`/emails/receiving/${EMAIL_ID}`]: () => jsonResponse(emailResponse),
  "/att-1": () => binaryResponse(PDF, "application/pdf"),
  "/att-2": () => binaryResponse(PNG, "image/png"),
};

interface Recorder {
  store: EmailEnrichmentStore;
  objects: Map<string, DownloadedMedia>;
  finishedAssets: Array<{ assetId: string; evidence: MediaEvidence | null; errorCode?: string }>;
  finished: Array<string | undefined>;
}

function recordingStore(assets: EmailAsset[], overrides: Partial<EmailEnrichmentStore> = {}): Recorder {
  const objects = new Map<string, DownloadedMedia>();
  const finishedAssets: Recorder["finishedAssets"] = [];
  const finished: Array<string | undefined> = [];
  let claimed = false;

  const store: EmailEnrichmentStore = {
    async claim(): Promise<EmailEnrichmentJob | undefined> {
      if (claimed) return undefined;
      claimed = true;
      return { id: "job-1", captureId: "capture-1", attempts: 1 };
    },
    async loadEmailId() {
      return EMAIL_ID;
    },
    async loadAssets() {
      return assets;
    },
    async read(target) {
      const stored = objects.get(target.storagePath);
      return stored ? { bytes: stored.bytes, mediaType: stored.mediaType } : undefined;
    },
    async put(target, media) {
      objects.set(target.storagePath, media);
    },
    async finishAsset(_job, target, evidence, errorCode) {
      finishedAssets.push({ assetId: target.id, evidence, ...(errorCode ? { errorCode } : {}) });
      return true;
    },
    async finish(_job, errorCode) {
      finished.push(errorCode);
      return errorCode === undefined;
    },
    ...overrides,
  };

  return { store, objects, finishedAssets, finished };
}

describe("email enrichment", () => {
  it("is idle with no pending job", async () => {
    const { store } = recordingStore([]);
    expect(
      await processNextEmailEnrichmentJob(
        { ...store, claim: async () => undefined },
        config,
        fakeFetch({}),
      ),
    ).toEqual({ status: "idle" });
  });

  it("AC5 retains the parsed representation and exact attachment bytes privately", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "application/pdf" }),
      asset({ id: "asset-2", role: "email_attachment", providerAttachmentId: "att-2", mediaType: "image/png" }),
    ];
    const recorder = recordingStore(assets);

    const outcome = await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch(happyRoutes),
      () => new Date("2026-09-08T10:00:30.000Z"),
    );

    expect(outcome).toEqual({ status: "succeeded", jobId: "job-1", captureId: "capture-1" });
    expect(recorder.finished).toEqual([undefined]);

    // Original attachment bytes, byte-for-byte, under the capture's own storage paths.
    expect(recorder.objects.get(assets[1].storagePath)?.bytes.equals(PDF)).toBe(true);
    expect(recorder.objects.get(assets[2].storagePath)?.bytes.equals(PNG)).toBe(true);
    expect(recorder.finishedAssets.map((entry) => entry.evidence?.sha256)).toEqual([
      recorder.objects.get(REPRESENTATION.storagePath)!.sha256,
      digest(PDF),
      digest(PNG),
    ]);
    expect(recorder.finishedAssets.every((entry) => entry.errorCode === undefined)).toBe(true);

    const stored = parseStoredRepresentation(recorder.objects.get(REPRESENTATION.storagePath)!.bytes)!;
    expect(stored.text).toBe(emailResponse.text);
    expect(stored.html).toBe(emailResponse.html);
    expect(stored.headers).toEqual(emailResponse.headers);
    expect(stored.attachments).toHaveLength(2);
    // Every URL of the one original email, in encounter order, on that one capture.
    expect(stored.urls).toEqual([
      "https://example.com/one",
      "https://example.com/two",
      "https://example.com/one",
    ]);
    // Temporary provider download URLs are credentials, never durable content.
    expect(JSON.stringify(stored)).not.toMatch(/download_url|downloadUrl|signature=|secret-signature/u);
  });

  it("AC6 leaves the capture intact and marks a safe failure when retrieval fails", async () => {
    const recorder = recordingStore([REPRESENTATION]);

    const outcome = await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({
        [`/emails/receiving/${EMAIL_ID}`]: () => new Response("upstream boom", { status: 503 }),
      }),
    );

    expect(outcome).toEqual({ status: "failed", jobId: "job-1", captureId: "capture-1" });
    // Retryable: the job carries the code, no asset was declared stored, nothing was written.
    expect(recorder.finished).toEqual(["email_unavailable"]);
    expect(recorder.finishedAssets).toEqual([]);
    expect(recorder.objects.size).toBe(0);
  });

  it("AC6 never records provider-controlled text as a failure reason", async () => {
    const recorder = recordingStore([REPRESENTATION]);

    await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({
        [`/emails/receiving/${EMAIL_ID}`]: () => {
          throw new Error("connect ECONNREFUSED secret-host.internal");
        },
      }),
    );

    expect(recorder.finished).toEqual(["email_unavailable"]);
    expect(JSON.stringify(recorder.finished)).not.toContain("secret-host");
  });

  it("AC6 keeps a failed attachment terminal without discarding the rest of the email", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "application/pdf" }),
      asset({ id: "asset-2", role: "email_attachment", providerAttachmentId: "att-missing", mediaType: "image/png" }),
    ];
    const recorder = recordingStore(assets);

    const outcome = await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({
        ...happyRoutes,
        "/att-1": () => new Response("gone", { status: 410 }),
      }),
    );

    expect(outcome.status).toBe("succeeded");
    expect(recorder.finishedAssets).toEqual([
      { assetId: "asset-representation", evidence: expect.objectContaining({ mediaType: "application/json" }) },
      { assetId: "asset-1", evidence: null, errorCode: "email_missing" },
      { assetId: "asset-2", evidence: null, errorCode: "attachment_missing" },
    ]);
    // The parsed email is still complete and stored.
    expect(recorder.objects.has(REPRESENTATION.storagePath)).toBe(true);
  });

  it("AC6 refuses an attachment served from a host outside Resend", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "application/pdf" }),
    ];
    const recorder = recordingStore(assets);

    await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({
        ...happyRoutes,
        [`/emails/receiving/${EMAIL_ID}/attachments`]: () =>
          jsonResponse({
            object: "list",
            data: [{ ...attachmentList.data[0], download_url: "https://attacker.example/att-1" }],
          }),
      }),
    );

    expect(recorder.finishedAssets[1]).toEqual({
      assetId: "asset-1",
      evidence: null,
      errorCode: "unsafe_origin",
    });
    expect(recorder.objects.has(assets[1].storagePath)).toBe(false);
  });

  it("AC6 refuses an attachment whose bytes contradict its declared type", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "image/png" }),
    ];
    const recorder = recordingStore(assets);

    await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({ ...happyRoutes, "/att-1": () => binaryResponse(PDF, "image/png") }),
    );

    expect(recorder.finishedAssets[1]).toMatchObject({ assetId: "asset-1", errorCode: "media_mismatch" });
  });

  it("AC6 aborts the attempt for retry when an attachment download is transiently unavailable", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "application/pdf" }),
    ];
    const recorder = recordingStore(assets);

    const outcome = await processNextEmailEnrichmentJob(
      recorder.store,
      config,
      fakeFetch({ ...happyRoutes, "/att-1": () => new Response("busy", { status: 500 }) }),
    );

    expect(outcome.status).toBe("failed");
    expect(recorder.finished).toEqual(["email_unavailable"]);
    // The representation stored on this attempt is not undone, and the attachment stays pending.
    expect(recorder.finishedAssets.map((entry) => entry.assetId)).toEqual(["asset-representation"]);
  });

  it("AC6 refuses to store an oversized email representation", async () => {
    const recorder = recordingStore([REPRESENTATION]);

    await processNextEmailEnrichmentJob(
      recorder.store,
      { ...config, maxBytes: 256 },
      fakeFetch(happyRoutes),
    );

    expect(recorder.finished).toEqual(["email_too_large"]);
    expect(recorder.objects.size).toBe(0);
  });

  it("reconciles an attempt that uploaded before its receipt was written", async () => {
    const assets = [
      REPRESENTATION,
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", mediaType: "application/pdf" }),
    ];
    const recorder = recordingStore(assets);
    recorder.objects.set(assets[1].storagePath, {
      bytes: PDF,
      mediaType: "application/pdf",
      byteSize: PDF.length,
      sha256: digest(PDF),
    });
    const fetcher = fakeFetch(happyRoutes);

    const outcome = await processNextEmailEnrichmentJob(recorder.store, config, fetcher);

    expect(outcome.status).toBe("succeeded");
    expect(recorder.finishedAssets[1]).toMatchObject({ assetId: "asset-1" });
    expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input))).not.toContain(
      "https://inbound-cdn.resend.com/att-1?signature=sig-1",
    );
  });

  it("skips assets a previous attempt already settled", async () => {
    const assets = [
      { ...REPRESENTATION, storageState: "stored" },
      asset({ id: "asset-1", role: "email_attachment", providerAttachmentId: "att-1", storageState: "failed" }),
    ];
    const recorder = recordingStore(assets);

    const outcome = await processNextEmailEnrichmentJob(recorder.store, config, fakeFetch(happyRoutes));

    expect(outcome.status).toBe("succeeded");
    expect(recorder.finishedAssets).toEqual([]);
    expect(recorder.objects.size).toBe(0);
  });

  it("fails terminally when the capture behind the job is gone", async () => {
    const recorder = recordingStore([]);

    const outcome = await processNextEmailEnrichmentJob(
      { ...recorder.store, loadEmailId: async () => undefined },
      config,
      fakeFetch(happyRoutes),
    );

    expect(outcome.status).toBe("failed");
    expect(recorder.finished).toEqual(["capture_missing"]);
  });
});
