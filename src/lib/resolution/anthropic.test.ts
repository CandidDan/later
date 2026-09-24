import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("server-only", () => ({}));

const {
  configuredResolutionModel,
  createSourceResolutionAnalyser,
  SOURCE_RESULT_JSON_SCHEMA,
} = await import("./anthropic");
const { SourceResolutionAnalysisError } = await import("./protocol");
const { SourceResolutionResultSchemaError } = await import("./result");
const { expectAnthropicCompatibleSchema } = await import("../processing/anthropic-schema.test-helpers");
type SourceResolutionMessagesClient = import("./anthropic").SourceResolutionMessagesClient;
type SourceResolutionInputSnapshot = import("./input").SourceResolutionInputSnapshot;
type SourceEvidence = import("./result").SourceEvidence;

const evidence: SourceEvidence[] = [
  { id: "metadata.0.title", kind: "metadata_title", value: "Known Episode" },
  { id: "metadata.0.creator", kind: "metadata_creator", value: "Known Creator" },
  { id: "metadata.0.canonicalUrl", kind: "metadata_canonical_url", value: "https://example.com/known" },
];
const snapshot = {
  capture: { captureId: "capture-10" },
  intentAnalysis: { id: "intent-10" },
  publicMetadata: [{ title: "Known Episode" }],
  evidence: evidence.map((item) => ({ ...item })),
} as SourceResolutionInputSnapshot;
const validResult = {
  status: "resolved",
  sourceType: "podcast_episode",
  title: "Known Episode",
  creator: "Known Creator",
  canonicalUrl: "https://example.com/known",
  durationSeconds: null,
  transcriptUrl: null,
  confidence: 0.8,
  evidence: evidence.map(({ id }) => id),
};

function message(text: string, model = "claude-resolution-reported"): Anthropic.Message {
  return {
    id: "message-10",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

function clientReturning(value: Anthropic.Message) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: SourceResolutionMessagesClient = {
    messages: { create: async (body) => { bodies.push(body); return value; } },
  };
  return { client, bodies };
}

afterEach(() => { delete process.env.ANTHROPIC_RESOLUTION_MODEL; });

describe("Anthropic source resolution", () => {
  it("later-0013 AC2/AC6 sends a compatible closed nullable source schema and preserves valid output provenance", async () => {
    process.env.ANTHROPIC_RESOLUTION_MODEL = "claude-resolution-configured";
    const { client, bodies } = clientReturning(message(JSON.stringify(validResult)));

    const result = await createSourceResolutionAnalyser(client, configuredResolutionModel())(snapshot, evidence);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("claude-resolution-configured");
    const schema = bodies[0].output_config?.format?.schema;
    expectAnthropicCompatibleSchema(schema);
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["status", "sourceType", "title", "creator", "canonicalUrl", "durationSeconds", "transcriptUrl", "confidence", "evidence"],
      properties: {
        status: { enum: ["resolved", "unresolved"] },
        sourceType: { anyOf: [{ type: "string", enum: expect.any(Array) }, { type: "null" }] },
        durationSeconds: { type: ["integer", "null"] },
        transcriptUrl: { type: ["string", "null"] },
      },
    });
    expect(SOURCE_RESULT_JSON_SCHEMA.properties.durationSeconds).toHaveProperty("minimum", 1);
    expect(JSON.stringify(bodies[0].messages)).toContain("metadata.0.canonicalUrl");
    expect(result.modelId).toBe("claude-resolution-reported");
    expect(result.result).toStrictEqual(validResult);
  });

  it("later-0013 AC4 rejects a non-positive duration after transport removes minimum", async () => {
    const invalid = { ...validResult, durationSeconds: 0 };
    const { client } = clientReturning(message(JSON.stringify(invalid)));
    await expect(createSourceResolutionAnalyser(client, "configured")(snapshot, evidence))
      .rejects.toBeInstanceOf(SourceResolutionResultSchemaError);
  });

  it("later-0013 AC5 sanitizes Anthropic HTTP 400 and leaves outage classes unchanged", async () => {
    const throwingClient = (failure: Error): SourceResolutionMessagesClient => ({
      messages: { create: async () => { throw failure; } },
    });
    const invalidRequest = Object.assign(new Error("private provider detail"), { status: 400 });
    await expect(createSourceResolutionAnalyser(throwingClient(invalidRequest), "configured")(snapshot, evidence))
      .rejects.toStrictEqual(expect.objectContaining({
        name: "SourceResolutionAnalysisError",
        message: "Anthropic rejected the source request",
      }));
    for (const status of [401, 429, 503]) {
      const failure = Object.assign(new Error("unavailable"), { status });
      await expect(createSourceResolutionAnalyser(throwingClient(failure), "configured")(snapshot, evidence))
        .rejects.toBe(failure);
    }
  });

  it("AC2 rejects a model identity that is absent from its cited immutable snapshot", async () => {
    const invented = { ...validResult, canonicalUrl: "https://invented.example/source" };
    const { client } = clientReturning(message(JSON.stringify(invented)));
    await expect(createSourceResolutionAnalyser(client, "configured")(snapshot, evidence))
      .rejects.toBeInstanceOf(SourceResolutionResultSchemaError);
  });

  it("AC5 treats unparseable output and refusals as safe provider failures", async () => {
    const invalid = clientReturning(message("not-json"));
    await expect(createSourceResolutionAnalyser(invalid.client, "configured")(snapshot, evidence))
      .rejects.toBeInstanceOf(SourceResolutionAnalysisError);

    const refusal = clientReturning({ ...message("{}"), stop_reason: "refusal" } as Anthropic.Message);
    await expect(createSourceResolutionAnalyser(refusal.client, "configured")(snapshot, evidence))
      .rejects.toBeInstanceOf(SourceResolutionAnalysisError);
  });
});
