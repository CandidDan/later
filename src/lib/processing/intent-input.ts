import { normalizeCaptureInput } from "../capture/normalize";
import type { CaptureRecord, JsonValue } from "../jobs/types";

/**
 * Provider message metadata is copied through an allow-list, never a deny-list. Everything
 * that identifies a person (phone numbers, WhatsApp ids, profile names) is therefore excluded
 * by construction rather than by remembering to strip it, and a new provider field cannot
 * leak private capture context into a model request by default.
 */
const METADATA_KEYS = {
  NumMedia: "mediaCount",
  NumSegments: "segmentCount",
  MessageType: "messageType",
} as const;

export interface IntentInputSnapshot extends Record<string, JsonValue> {
  captureId: string;
  channel: string;
  captureKind: string;
  rawText: string | null;
  urls: string[];
  userNote: string | null;
  sourcePlatform: string | null;
  capturedAt: string;
  messageMetadata: Record<string, JsonValue>;
  assets: Array<Record<string, JsonValue>>;
}

function metadataFrom(rawPayload: Record<string, JsonValue>): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = {};

  for (const [providerKey, snapshotKey] of Object.entries(METADATA_KEYS)) {
    const value = rawPayload[providerKey];

    if (value !== undefined && value !== null) {
      metadata[snapshotKey] = value;
    }
  }

  return metadata;
}

/**
 * Build the immutable capture-time snapshot the model is allowed to see. The snapshot is
 * stored verbatim alongside the run, so it is also the record of exactly what the model was
 * asked about — it can only ever contain fields that existed at capture time.
 */
export function buildIntentInputSnapshot(capture: CaptureRecord): IntentInputSnapshot {
  return {
    captureId: capture.id,
    channel: capture.channel,
    captureKind: capture.captureKind,
    rawText: capture.rawText,
    urls: [...normalizeCaptureInput({ rawText: capture.rawText ?? undefined }).urls],
    userNote: capture.userNote,
    sourcePlatform: capture.sourcePlatform,
    capturedAt: capture.capturedAt,
    messageMetadata: metadataFrom(capture.rawPayload),
    assets: capture.assets.map((asset) => ({
      filename: asset.filename,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
    })),
  };
}
