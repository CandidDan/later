import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("server-only", () => ({}));

const { configuredIntentModel, createIntentAnalyser } = await import("./anthropic");
const { buildIntentInputSnapshot } = await import("./intent-input");
const { IntentAnalysisError } = await import("./errors");
const { IntentResultSchemaError } = await import("./intent-result");
type CaptureRecord = import("../jobs/types").CaptureRecord;
type IntentMessagesClient = import("./anthropic").IntentMessagesClient;

const capture: CaptureRecord = {
  id: "capture-3",
  channel: "whatsapp",
  captureKind: "link",
  rawText: "https://open.spotify.com/track/xyz",
  userNote: null,
  sourcePlatform: "spotify",
  capturedAt: "2026-09-01T12:00:00.000Z",
  rawPayload: {},
  assets: [],
};

const validResult = {
  contentType: "audio",
  interest: { summary: "Wants this track for a running playlist", confidence: 0.7 },
  classification: { value: "atomic", confidence: 0.9 },
  underlyingSource: { hints: ["spotify track"], confidence: 0.8 },
  resolutionRequired: false,
  evidence: [{ field: "urls", observation: "a single spotify track link", weight: "primary" }],
};

function messageReturning(text: string, reportedModel: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: reportedModel,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

function clientReturning(
  message: Anthropic.Message,
): { client: IntentMessagesClient; bodies: Anthropic.MessageCreateParamsNonStreaming[] } {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];

  return {
    bodies,
    client: {
      messages: {
        create: async (body) => {
          bodies.push(body);
          return message;
        },
      },
    },
  };
}

afterEach(() => {
  delete process.env.ANTHROPIC_INTENT_MODEL;
});

describe("createIntentAnalyser", () => {
  it.each([
    ["a Haiku model", "claude-haiku-4-5", "claude-haiku-4-5"],
    ["a Sonnet model", "claude-sonnet-5", "claude-sonnet-5-20260101"],
  ])(
    "AC6 calls %s exactly as configured and records the model the API reports",
    async (_label, configured, reported) => {
      process.env.ANTHROPIC_INTENT_MODEL = configured;
      const { client, bodies } = clientReturning(
        messageReturning(JSON.stringify(validResult), reported),
      );

      const analysis = await createIntentAnalyser(client, configuredIntentModel())(
        buildIntentInputSnapshot(capture),
      );

      expect(bodies).toHaveLength(1);
      expect(bodies[0].model).toBe(configured);
      expect(analysis.modelId).toBe(reported);
      expect(analysis.result.classification.value).toBe("atomic");
    },
  );

  it("AC6 requires the model to be configured rather than defaulting to one in code", () => {
    expect(() => configuredIntentModel()).toThrow(/ANTHROPIC_INTENT_MODEL is required/u);
  });

  it("AC1 constrains the response to the v0 schema and sends only the capture snapshot", async () => {
    const { client, bodies } = clientReturning(
      messageReturning(JSON.stringify(validResult), "claude-haiku-4-5"),
    );

    await createIntentAnalyser(client, "claude-haiku-4-5")(buildIntentInputSnapshot(capture));

    expect(bodies[0].output_config?.format?.type).toBe("json_schema");
    expect(bodies[0].output_config?.format?.schema.required).toStrictEqual([
      "contentType",
      "interest",
      "classification",
      "underlyingSource",
      "resolutionRequired",
      "evidence",
    ]);
    expect(JSON.stringify(bodies[0].messages)).toContain("capture-3");
  });

  it("AC3 surfaces a schema-invalid model response as a schema error, not a result", async () => {
    const invalid = { ...validResult, classification: { value: "definitely", confidence: 2 } };
    const { client } = clientReturning(
      messageReturning(JSON.stringify(invalid), "claude-haiku-4-5"),
    );

    await expect(
      createIntentAnalyser(client, "claude-haiku-4-5")(buildIntentInputSnapshot(capture)),
    ).rejects.toThrow(IntentResultSchemaError);
  });

  it("AC3 surfaces unparseable output as an analysis error", async () => {
    const { client } = clientReturning(messageReturning("not json at all", "claude-haiku-4-5"));

    await expect(
      createIntentAnalyser(client, "claude-haiku-4-5")(buildIntentInputSnapshot(capture)),
    ).rejects.toThrow(IntentAnalysisError);
  });

  it("AC3 surfaces a provider transport failure to the caller unchanged", async () => {
    const client: IntentMessagesClient = {
      messages: {
        create: async () => {
          throw Object.assign(new Error("service unavailable"), { status: 503 });
        },
      },
    };

    await expect(
      createIntentAnalyser(client, "claude-haiku-4-5")(buildIntentInputSnapshot(capture)),
    ).rejects.toThrow(/service unavailable/u);
  });

  it("AC3 treats a refusal as a failed run rather than an empty success", async () => {
    const refusal = {
      ...messageReturning("{}", "claude-haiku-4-5"),
      stop_reason: "refusal",
    } as unknown as Anthropic.Message;
    const { client } = clientReturning(refusal);

    await expect(
      createIntentAnalyser(client, "claude-haiku-4-5")(buildIntentInputSnapshot(capture)),
    ).rejects.toThrow(IntentAnalysisError);
  });
});
