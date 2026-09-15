import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("server-only", () => ({}));

const { configuredSegmentModel, createSegmentResolutionAnalyser, SEGMENT_RESULT_JSON_SCHEMA } =
  await import("./segment-anthropic");
const { SegmentResolutionAnalysisError } = await import("./segment-protocol");
type SegmentResolutionMessagesClient = import("./segment-anthropic").SegmentResolutionMessagesClient;
type SegmentMaterial = import("./segment-material").SegmentMaterial;
type SegmentResolutionInputSnapshot = import("./segment-input").SegmentResolutionInputSnapshot;

const material: SegmentMaterial = {
  requestedUrl: "https://example.com/transcript.vtt", finalUrl: "https://example.com/transcript.vtt",
  contentType: "text/vtt", sha256: "a".repeat(64), byteLength: 80,
  representation: "timed", durationSeconds: 60, content: "Durable queues survive retries",
  evidence: [{ id: "cue.0", kind: "timed", startSeconds: 10, endSeconds: 18,
    text: "Durable queues survive retries" }],
};
const snapshot = {
  segmentJob: { id: "segment-11", attempt: 1 },
  sourceAnalysis: { id: "source-11" },
  frozenInterest: { summary: "durable queues" },
  sourceMaterial: { finalUrl: material.finalUrl, sha256: material.sha256 },
  evidence: material.evidence.map((item) => ({ ...item })),
} as SegmentResolutionInputSnapshot;
const validResult = {
  status: "resolved", representation: "timed", startSeconds: 10, endSeconds: 18,
  sectionStart: null, sectionEnd: null, excerpt: "Durable queues survive retries", label: null,
  confidence: 0.9, evidence: ["cue.0"],
};

function message(text: string, model = "claude-segment-reported"): Anthropic.Message {
  return { id: "message-11", type: "message", role: "assistant", model,
    content: [{ type: "text", text, citations: null }], stop_reason: "end_turn",
    stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } } as unknown as Anthropic.Message;
}

function clientReturning(value: Anthropic.Message) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: SegmentResolutionMessagesClient = {
    messages: { create: async (body) => { bodies.push(body); return value; } },
  };
  return { client, bodies };
}

afterEach(() => { delete process.env.ANTHROPIC_SEGMENT_MODEL; });

describe("Anthropic segment resolution", () => {
  it("AC1 sends the frozen interest, exact material digest and evidence through the separately configured model", async () => {
    process.env.ANTHROPIC_SEGMENT_MODEL = "claude-segment-configured";
    const { client, bodies } = clientReturning(message(JSON.stringify(validResult)));
    const result = await createSegmentResolutionAnalyser(client, configuredSegmentModel())(
      snapshot, material, material.evidence,
    );
    expect(bodies[0].model).toBe("claude-segment-configured");
    expect(bodies[0].output_config?.format?.schema).toStrictEqual(SEGMENT_RESULT_JSON_SCHEMA);
    expect(JSON.stringify(bodies[0].messages)).toContain(material.sha256);
    expect(JSON.stringify(bodies[0].messages)).toContain("durable queues");
    expect(result.modelId).toBe("claude-segment-reported");
  });

  it("AC4 treats invalid JSON and refusal as safe model failures", async () => {
    await expect(createSegmentResolutionAnalyser(clientReturning(message("not-json")).client, "configured")(
      snapshot, material, material.evidence,
    )).rejects.toBeInstanceOf(SegmentResolutionAnalysisError);
    const refusal = { ...message("{}"), stop_reason: "refusal" } as Anthropic.Message;
    await expect(createSegmentResolutionAnalyser(clientReturning(refusal).client, "configured")(
      snapshot, material, material.evidence,
    )).rejects.toBeInstanceOf(SegmentResolutionAnalysisError);
  });
});
