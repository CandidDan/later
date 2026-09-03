import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  INTENT_RESULT_JSON_SCHEMA,
  INTENT_SYSTEM_PROMPT,
  buildIntentUserMessage,
} from "./prompt";
import { parseIntentResult, type IntentResult } from "./intent-result";
import { IntentAnalysisError } from "./errors";
import type { IntentInputSnapshot } from "./intent-input";

const MAX_OUTPUT_TOKENS = 2048;

export interface IntentAnalysis {
  result: IntentResult;
  /** The model the API reports for this run, not the one we asked for. */
  modelId: string;
}

export interface IntentAnalyser {
  (snapshot: IntentInputSnapshot): Promise<IntentAnalysis>;
}

/** The subset of the Anthropic SDK the analyser uses, so tests can supply a stand-in. */
export interface IntentMessagesClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

function requiredEnvironmentVariable(
  name: "ANTHROPIC_API_KEY" | "ANTHROPIC_INTENT_MODEL",
): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for server-side intent analysis`);
  }

  return value.trim();
}

export function createAnthropicClient(): IntentMessagesClient {
  return new Anthropic({ apiKey: requiredEnvironmentVariable("ANTHROPIC_API_KEY") });
}

/**
 * The model identifier is configuration, never a baked-in alias. Swapping the experiment
 * between a Haiku and a Sonnet model is an environment change, and the identifier the API
 * reports back is recorded so each frozen run carries its own provenance.
 */
export function configuredIntentModel(): string {
  return requiredEnvironmentVariable("ANTHROPIC_INTENT_MODEL");
}

function textFrom(message: Anthropic.Message): string {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim().length === 0) {
    throw new IntentAnalysisError(
      `Anthropic returned no text content (stop reason: ${message.stop_reason ?? "unknown"})`,
    );
  }

  return text;
}

/**
 * Build an analyser bound to a client and a configured model. The request deliberately sets
 * nothing beyond the schema and token ceiling: thinking and effort are not supported uniformly
 * across the Haiku and Sonnet models this experiment compares, and the point is that the model
 * can be swapped by configuration alone.
 */
export function createIntentAnalyser(
  client: IntentMessagesClient = createAnthropicClient(),
  model: string = configuredIntentModel(),
): IntentAnalyser {
  return async (snapshot) => {
    const message = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: INTENT_SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: INTENT_RESULT_JSON_SCHEMA } },
      messages: [{ role: "user", content: buildIntentUserMessage(snapshot) }],
    });

    if (message.stop_reason === "refusal") {
      throw new IntentAnalysisError("Anthropic declined the intent request");
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(textFrom(message));
    } catch (error) {
      throw new IntentAnalysisError(
        `Anthropic returned unparseable JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    return { result: parseIntentResult(parsed), modelId: message.model };
  };
}
