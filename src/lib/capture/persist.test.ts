import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { normalizeCaptureInput } from "./normalize";
import {
  persistCapture,
  type AtomicCaptureRpcClient,
  type PersistableNormalizedCapture,
} from "./persist";

type RpcArguments = Parameters<AtomicCaptureRpcClient["rpc"]>[1];

class AtomicMemoryDatabase implements AtomicCaptureRpcClient {
  captures: Array<{ id: string; input: RpcArguments }> = [];
  assets: Array<{ captureId: string; metadata: RpcArguments["p_assets"][number] }> = [];
  jobs: Array<{ id: string; captureId: string; type: "intent_analysis"; status: "pending" }> = [];
  failNextJob = false;

  async rpc(functionName: "persist_capture_with_intent_job", input: RpcArguments) {
    expect(functionName).toBe("persist_capture_with_intent_job");
    const existing = input.p_external_message_id
      ? this.captures.find(
          ({ input: saved }) =>
            saved.p_user_id === input.p_user_id &&
            saved.p_capture_channel === input.p_capture_channel &&
            saved.p_external_message_id === input.p_external_message_id,
        )
      : undefined;

    if (existing) {
      const job = this.jobs.find(({ captureId }) => captureId === existing.id);
      return {
        data: [{ capture_id: existing.id, intent_job_id: job?.id, created: false }],
        error: null,
      };
    }

    const captureId = `capture-${this.captures.length + 1}`;
    const jobId = `job-${this.jobs.length + 1}`;
    const pendingCapture = { id: captureId, input: structuredClone(input) };
    const pendingAssets = input.p_assets.map((metadata) => ({
      captureId,
      metadata: structuredClone(metadata),
    }));

    if (this.failNextJob) {
      this.failNextJob = false;
      return { data: null, error: { message: "injected job insert failure" } };
    }

    this.captures.push(pendingCapture);
    this.assets.push(...pendingAssets);
    this.jobs.push({ id: jobId, captureId, type: "intent_analysis", status: "pending" });
    return {
      data: [{ capture_id: captureId, intent_job_id: jobId, created: true }],
      error: null,
    };
  }
}

const userId = "11111111-1111-1111-1111-111111111111";

function normalizedCapture(
  overrides: Partial<PersistableNormalizedCapture> = {},
): PersistableNormalizedCapture {
  const normalized = normalizeCaptureInput({
    channel: "whatsapp",
    capturedAt: "2026-09-03T01:30:00Z",
    rawText: "Keep https://example.test/item",
    rawProviderPayload: { nested: { untouched: true }, sequence: [1, 2, 3] },
  });

  return {
    ...normalized,
    channel: "whatsapp",
    capturedAt: "2026-09-03T01:30:00Z",
    rawProviderPayload: { nested: { untouched: true }, sequence: [1, 2, 3] },
    ...overrides,
  };
}

describe("persistCapture", () => {
  it("AC1 commits the capture, unchanged asset metadata, raw payload, and one pending intent job", async () => {
    const database = new AtomicMemoryDatabase();
    const rawProviderPayload = { nested: { untouched: true }, sequence: [1, 2, 3] };
    const attachments = [
      { id: "media-1", fileName: "photo.jpg", contentType: "image/jpeg", providerIndex: 0 },
    ];

    const result = await persistCapture(
      { userId, capture: normalizedCapture({ rawProviderPayload, attachments }) },
      database,
    );

    expect(result).toEqual({ captureId: "capture-1", intentJobId: "job-1", created: true });
    expect(database.captures).toHaveLength(1);
    expect(database.captures[0]?.input.p_raw_payload).toEqual(rawProviderPayload);
    expect(database.assets.map(({ metadata }) => metadata)).toEqual(attachments);
    expect(database.jobs).toEqual([
      { id: "job-1", captureId: "capture-1", type: "intent_analysis", status: "pending" },
    ]);
  });

  it("AC2 rolls back capture and asset outcomes when initial intent-job creation fails", async () => {
    const database = new AtomicMemoryDatabase();
    database.failNextJob = true;

    await expect(
      persistCapture(
        { userId, capture: normalizedCapture({ attachments: [{ id: "media-1" }] }) },
        database,
      ),
    ).rejects.toThrow("injected job insert failure");

    expect(database.captures).toEqual([]);
    expect(database.assets).toEqual([]);
    expect(database.jobs).toEqual([]);
  });

  it("AC3 returns one capture and one initial job across provider retries", async () => {
    const database = new AtomicMemoryDatabase();
    const capture = normalizedCapture({ externalMessageId: "SM-retry" });

    const first = await persistCapture({ userId, capture }, database);
    const retry = await persistCapture({ userId, capture }, database);

    expect(first.created).toBe(true);
    expect(retry).toEqual({ ...first, created: false });
    expect(database.captures).toHaveLength(1);
    expect(database.jobs).toHaveLength(1);
  });

  it("AC4 creates distinct capture and pending-job outcomes without an external message id", async () => {
    const database = new AtomicMemoryDatabase();
    const capture = normalizedCapture({ externalMessageId: undefined });

    const first = await persistCapture({ userId, capture }, database);
    const second = await persistCapture({ userId, capture }, database);

    expect(second.captureId).not.toBe(first.captureId);
    expect(database.captures).toHaveLength(2);
    expect(database.jobs).toHaveLength(2);
  });

  it("AC6 accepts the provider-neutral normalized contract without enrichment fields", async () => {
    const database = new AtomicMemoryDatabase();
    const capture = normalizedCapture({ sourcePlatform: undefined });

    await expect(persistCapture({ userId, capture }, database)).resolves.toMatchObject({
      created: true,
    });
    expect(database.captures[0]?.input).toMatchObject({
      p_capture_channel: "whatsapp",
      p_source_platform: null,
    });
    expect(database.captures[0]?.input).not.toHaveProperty("provider");
    expect(database.captures[0]?.input).not.toHaveProperty("analysis");
  });
});
