import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnalysisRecordInput, CaptureRecord, CaptureJobStore } from "../jobs/types";
import { digest } from "../assets/media";
import { buildEnrichedIntentInput } from "./media-input";
import { processNextIntentJob } from "./intent";
vi.mock("server-only", () => ({}));
const { createIntentAnalyser } = await import("./anthropic");
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
const capture: CaptureRecord = { id: "capture", channel: "whatsapp", captureKind: "attachment", rawText: null,
  userNote: null, sourcePlatform: null, capturedAt: "2026-09-07T00:00:00Z", rawPayload: { MediaUrl0: "https://provider.invalid/temporary", token: "secret-value" },
  assets: [{ id: "image", filename: "image", mediaType: "image/png", byteSize: null, storageState: "stored",
    storagePath: "captures/user/capture/image", observedMediaType: "image/png", storedByteSize: bytes.length, sha256: digest(bytes) },
    ...["audio/ogg", "video/mp4", "application/pdf"].map((mediaType, n) => ({ id: `unsupported-${n}`, filename: `original-${n}`, mediaType, byteSize: null,
      storageState: "stored", observedMediaType: mediaType, storedByteSize: 12, sha256: "a".repeat(64) }))] };
const result = { contentType: "image", interest: { summary: "Saved an image", confidence: 0.6 }, classification: { value: "reference", confidence: 0.6 },
  underlyingSource: { hints: [], confidence: 0.1 }, resolutionRequired: false,
  evidence: [{ field: "assets", observation: "image content", weight: "primary" }] };

describe("media-enriched intent", () => {
  it("AC6 sends supported private image bytes to Anthropic and persists stable provenance only", async () => {
    const read = vi.fn(async () => bytes);
    const input = await buildEnrichedIntentInput(capture, read);
    const create = vi.fn(async () => ({ model: "test-model", content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn" }) as Anthropic.Message);
    await createIntentAnalyser({ messages: { create } }, "test-model")(input.snapshot, input.images);
    expect(read).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toBeDefined();
    const body = (create.mock.calls as unknown as [[Anthropic.MessageCreateParamsNonStreaming]])[0][0];
    expect(body.messages[0].content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } });
    expect(input.snapshot.assets[0]).toEqual({ assetId: "image", filename: "image", storageState: "stored", mediaType: "image/png",
      byteSize: bytes.length, sha256: digest(bytes), contentAnalysis: "image" });
    expect(input.snapshot.assets.slice(1).map(a => a.contentAnalysis)).toEqual(["metadata_only", "metadata_only", "metadata_only"]);
    expect(JSON.stringify(input.snapshot)).not.toMatch(/temporary|provider\.invalid|secret-value|storagePath|base64|iVBOR/u);
    expect(body.system).toContain("metadata_only");
  });
  it("AC5 appends enrichment while preserving the original run byte-for-byte", async () => {
    const records: AnalysisRecordInput[] = [];
    let n = 0;
    const store: CaptureJobStore = { claimNextJob: async () => ({ id: `job-${++n}`, captureId: capture.id,
      jobType: "intent_analysis", attempts: 1, intentPhase: n === 1 ? "initial" : "enriched" }),
      loadCapture: async () => capture, finishAttempt: async (_job, record) => { records.push(structuredClone(record!)); return { analysisId: String(records.length) }; } };
    const analyse = vi.fn(async () => ({ modelId: "test", result: result as Awaited<ReturnType<import("./anthropic").IntentAnalyser>>["result"] }));
    const readImage = vi.fn(async () => bytes);
    await processNextIntentJob({ store, analyse, readImage });
    expect(readImage).not.toHaveBeenCalled();
    const original = JSON.stringify(records[0]);
    await processNextIntentJob({ store, analyse, readImage });
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records[0])).toBe(original);
    expect(records[1].inputSnapshot).toHaveProperty("analysisPhase", "enriched");
    expect(records[1].pipelineVersion).toBe("intent-pipeline-media-v0.1");
    expect(JSON.stringify(records[1].inputSnapshot)).not.toContain(bytes.toString("base64"));
    expect(readImage).toHaveBeenCalledTimes(1);
  });
  it("does not analyse or label missing, modified or over-limit bytes as image evidence", async () => {
    await expect(buildEnrichedIntentInput(capture, async () => Buffer.from("corrupt"))).rejects.toThrow("storage_conflict");
    const read = vi.fn(async () => bytes);
    const input = await buildEnrichedIntentInput({ ...capture, assets: [{ ...capture.assets[0], storedByteSize: 6 * 1024 * 1024 },
      { ...capture.assets[0], id: "failed", storageState: "failed" }] }, read);
    expect(input.images).toEqual([]); expect(read).not.toHaveBeenCalled();
    expect(input.snapshot.assets.map(a => a.contentAnalysis)).toEqual(["metadata_only_size_limit", "metadata_only"]);
  });
});
