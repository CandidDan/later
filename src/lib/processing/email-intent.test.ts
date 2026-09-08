import { describe, expect, it, vi } from "vitest";

import { digest } from "../assets/media";
import {
  buildStoredRepresentation,
  serializeRepresentation,
} from "../email/representation";
import type {
  AnalysisRecordInput,
  CaptureJob,
  CaptureJobStore,
  CaptureRecord,
} from "../jobs/types";
import { processNextIntentJob } from "./intent";
import {
  MEDIA_PIPELINE_VERSION,
  MEDIA_PROMPT_VERSION,
  PIPELINE_VERSION,
  PROMPT_VERSION,
} from "./prompt";

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

const representation = buildStoredRepresentation(
  EMAIL_ID,
  {
    id: EMAIL_ID,
    subject: "Worth reading",
    from: "newsletter@example.com",
    to: ["capture@later.resend.app"],
    text: "Read https://example.com/article for the argument",
    html: "<p>Read it</p>",
    headers: { "list-id": "<news.example.com>" },
    attachments: [{ id: "att-1", filename: "brief.pdf", content_type: "application/pdf", size: 10 }],
  },
  "2026-09-08T10:00:30.000Z",
);
const representationBytes = serializeRepresentation(representation);

const result = {
  contentType: "article" as const,
  interest: { summary: "the argument in the newsletter", confidence: 0.8 },
  classification: { value: "reference" as const, confidence: 0.7 },
  underlyingSource: { hints: [], confidence: 0.5 },
  resolutionRequired: false,
  evidence: [{ field: "email" as const, observation: "the stored body argues a case", weight: "primary" as const }],
};

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "capture-1",
    channel: "email",
    captureKind: "email",
    rawText: "Worth reading",
    userNote: null,
    sourcePlatform: null,
    capturedAt: "2026-09-08T10:00:05.000Z",
    rawPayload: { provider: "resend", emailId: EMAIL_ID },
    assets: [
      {
        id: "asset-representation",
        role: "email_representation",
        filename: "email.json",
        mediaType: "application/json",
        byteSize: null,
        storagePath: "captures/user/capture-1/1-email.json",
        storageState: "stored",
        observedMediaType: "application/json",
        storedByteSize: representationBytes.length,
        sha256: digest(representationBytes),
      },
      {
        id: "asset-attachment",
        role: "email_attachment",
        filename: "brief.pdf",
        mediaType: "application/pdf",
        byteSize: 10,
        storagePath: "captures/user/capture-1/2-brief.pdf",
        storageState: "stored",
        observedMediaType: "application/pdf",
        storedByteSize: 10,
        sha256: "b".repeat(64),
      },
    ],
    ...overrides,
  };
}

function harness(job: CaptureJob, record?: CaptureRecord) {
  const records: AnalysisRecordInput[] = [];
  let claimed = false;
  const store: CaptureJobStore = {
    async claimNextJob() {
      if (claimed) return undefined;
      claimed = true;
      return job;
    },
    async loadCapture() {
      return record ?? capture();
    },
    async finishAttempt(_job, entry) {
      if (entry) records.push(entry);
      return { analysisId: `analysis-${records.length}` };
    },
  };

  return { store, records };
}

const analyse = vi.fn(async () => ({ modelId: "test-model", result }));

describe("enriched intent analysis of a stored email", () => {
  it("AC7 cites the stored representation and assets as provenance", async () => {
    const { store, records } = harness({
      id: "job-enriched",
      captureId: "capture-1",
      jobType: "intent_analysis",
      attempts: 1,
      intentPhase: "enriched",
    });

    const outcome = await processNextIntentJob({
      store,
      analyse,
      readImage: async () => representationBytes,
    });

    expect(outcome.status).toBe("succeeded");
    const [record] = records;
    const email = record.inputSnapshot.email as Record<string, unknown>;

    expect(record.inputSnapshot.analysisPhase).toBe("enriched");
    expect(email.contentAnalysis).toBe("email");
    // Provenance: the exact stored object this analysis was drawn from.
    expect(email.assetId).toBe("asset-representation");
    expect(email.sha256).toBe(digest(representationBytes));
    expect(email.byteSize).toBe(representationBytes.length);
    expect(email.storageState).toBe("stored");
    expect(email.text).toBe(representation.text);
    expect(email.urls).toEqual(["https://example.com/article"]);
    // And the attachments, by id and digest, alongside it.
    expect(record.inputSnapshot.assets).toEqual([
      expect.objectContaining({ assetId: "asset-representation", contentAnalysis: "email_representation" }),
      expect.objectContaining({ assetId: "asset-attachment", sha256: "b".repeat(64) }),
    ]);
    // Personal envelope data stays out of the model request.
    expect(JSON.stringify(record.inputSnapshot)).not.toMatch(/newsletter@|capture@later/u);
  });

  it("AC7 appends a distinct run rather than replacing the metadata-only one", async () => {
    const initial = harness({
      id: "job-initial",
      captureId: "capture-1",
      jobType: "intent_analysis",
      attempts: 1,
    });
    await processNextIntentJob({ store: initial.store, analyse });

    const enriched = harness({
      id: "job-enriched",
      captureId: "capture-1",
      jobType: "intent_analysis",
      attempts: 1,
      intentPhase: "enriched",
    });
    await processNextIntentJob({
      store: enriched.store,
      analyse,
      readImage: async () => representationBytes,
    });

    // Two separate append-only records, distinguishable by their recorded versions.
    expect(initial.records[0].pipelineVersion).toBe(PIPELINE_VERSION);
    expect(initial.records[0].promptVersion).toBe(PROMPT_VERSION);
    expect(enriched.records[0].pipelineVersion).toBe(MEDIA_PIPELINE_VERSION);
    expect(enriched.records[0].promptVersion).toBe(MEDIA_PROMPT_VERSION);
    // The earlier run saw only capture-time metadata; only the later one saw the email body.
    expect(initial.records[0].inputSnapshot.email).toBeUndefined();
    expect(initial.records[0].captureId).toBe(enriched.records[0].captureId);
  });

  it.each([
    ["is still pending", { storageState: "pending", storedByteSize: null, sha256: null }, "metadata_only"],
    ["failed to store", { storageState: "failed", storedByteSize: null, sha256: null }, "metadata_only"],
    ["is too large to read", { storedByteSize: 6 * 1024 * 1024 }, "metadata_only_size_limit"],
  ])("AC6 presents no email content when the representation %s", async (_name, overrides, expected) => {
    const record = capture();
    const assets = [{ ...record.assets[0], ...overrides }, record.assets[1]];
    const { store, records } = harness(
      {
        id: "job-enriched",
        captureId: "capture-1",
        jobType: "intent_analysis",
        attempts: 1,
        intentPhase: "enriched",
      },
      { ...record, assets },
    );

    await processNextIntentJob({ store, analyse, readImage: async () => representationBytes });

    const email = records[0].inputSnapshot.email as Record<string, unknown>;
    expect(email.contentAnalysis).toBe(expected);
    expect(email.text).toBeUndefined();
  });

  it("AC6 refuses to present bytes that no longer match the stored digest", async () => {
    const { store, records } = harness({
      id: "job-enriched",
      captureId: "capture-1",
      jobType: "intent_analysis",
      attempts: 1,
      intentPhase: "enriched",
    });

    await processNextIntentJob({
      store,
      analyse,
      readImage: async () => Buffer.from("tampered", "utf8"),
    });

    const email = records[0].inputSnapshot.email as Record<string, unknown>;
    expect(email.contentAnalysis).toBe("metadata_only_unreadable");
    expect(email.text).toBeUndefined();
  });
});
