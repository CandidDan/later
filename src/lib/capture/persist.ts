import "server-only";

import type { NormalizedCapture } from "./normalize";
import { createServiceRoleClient } from "../supabase/server";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface AtomicCaptureRpcArguments {
  p_user_id: string;
  p_capture_channel: string;
  p_external_message_id: string | null;
  p_capture_kind: NormalizedCapture["kind"];
  p_raw_text: string | null;
  p_user_note: string | null;
  p_source_platform: NormalizedCapture["sourcePlatform"] | null;
  p_captured_at: string;
  p_raw_payload: JsonValue;
  p_assets: JsonValue[];
}

interface RpcError {
  message: string;
}

export interface AtomicCaptureRpcClient {
  rpc(
    functionName: "persist_capture_with_intent_job",
    arguments_: AtomicCaptureRpcArguments,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface PersistableNormalizedCapture extends NormalizedCapture {
  channel: string;
  capturedAt: string;
  rawProviderPayload?: JsonValue;
}

export interface PersistCaptureInput {
  userId: string;
  capture: PersistableNormalizedCapture;
}

export interface PersistCaptureResult {
  captureId: string;
  intentJobId: string;
  created: boolean;
}

interface AtomicCaptureRow {
  capture_id: string;
  intent_job_id: string;
  created: boolean;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return (
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function requireJsonValue(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${field} must contain only JSON-compatible values`);
  }

  return value;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }

  return value;
}

function parseResult(data: unknown): AtomicCaptureRow {
  const candidate = Array.isArray(data) ? data[0] : data;

  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as Partial<AtomicCaptureRow>).capture_id !== "string" ||
    typeof (candidate as Partial<AtomicCaptureRow>).intent_job_id !== "string" ||
    typeof (candidate as Partial<AtomicCaptureRow>).created !== "boolean"
  ) {
    throw new Error("Capture persistence returned an invalid result");
  }

  return candidate as AtomicCaptureRow;
}

export async function persistCapture(
  input: PersistCaptureInput,
  client: AtomicCaptureRpcClient = createServiceRoleClient() as unknown as AtomicCaptureRpcClient,
): Promise<PersistCaptureResult> {
  const { capture } = input;
  const rawPayload = requireJsonValue(capture.rawProviderPayload ?? {}, "rawProviderPayload");
  const assets = (capture.attachments ?? []).map((attachment, index) =>
    requireJsonValue(attachment, `attachments[${index}]`),
  );

  const { data, error } = await client.rpc("persist_capture_with_intent_job", {
    p_user_id: requireNonEmpty(input.userId, "userId"),
    p_capture_channel: requireNonEmpty(capture.channel, "capture.channel"),
    p_external_message_id: capture.externalMessageId || null,
    p_capture_kind: capture.kind,
    p_raw_text: capture.rawText ?? null,
    p_user_note: capture.userNote ?? null,
    p_source_platform: capture.sourcePlatform ?? null,
    p_captured_at: requireNonEmpty(capture.capturedAt, "capture.capturedAt"),
    p_raw_payload: rawPayload,
    p_assets: assets,
  });

  if (error) {
    throw new Error(`Failed to persist capture atomically: ${error.message}`);
  }

  const row = parseResult(data);
  return {
    captureId: row.capture_id,
    intentJobId: row.intent_job_id,
    created: row.created,
  };
}
