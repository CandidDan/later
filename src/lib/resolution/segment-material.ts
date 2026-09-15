import { createHash } from "node:crypto";

import {
  DEFAULT_METADATA_MAX_BYTES,
  fetchPublicDocument,
  MetadataError,
  SEGMENT_CONTENT_TYPES,
  type MetadataFetchOptions,
} from "./metadata";

export const DEFAULT_SEGMENT_MAX_BYTES = DEFAULT_METADATA_MAX_BYTES;
const MAX_SEGMENT_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_CHUNK_SIZE = 1_200;

export type SegmentRepresentation = "timed" | "text";

export interface TimedSegmentEvidence {
  id: string;
  kind: "timed";
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TextSegmentEvidence {
  id: string;
  kind: "text";
  start: number;
  end: number;
  text: string;
}

export interface SegmentNoticeEvidence {
  id: string;
  kind: "notice";
  value: string;
}

export type SegmentEvidence =
  | TimedSegmentEvidence
  | TextSegmentEvidence
  | SegmentNoticeEvidence;

export interface SegmentMaterial {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  sha256: string;
  byteLength: number;
  representation: SegmentRepresentation;
  durationSeconds: number | null;
  content: string;
  evidence: Array<TimedSegmentEvidence | TextSegmentEvidence>;
}

export function configuredSegmentMaxBytes(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.SEGMENT_SOURCE_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_SEGMENT_MAX_BYTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEGMENT_MAX_BYTES) {
    throw new Error("SEGMENT_SOURCE_MAX_BYTES must be an integer from 1 to 2097152");
  }
  return value;
}

function timestampSeconds(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(raw.trim())) return Number(raw);
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u.exec(raw.trim());
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? "0").padEnd(3, "0"));
  if (minutes > 59 || seconds > 59) return undefined;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function cleanCueText(value: string): string {
  return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseWebVtt(text: string): TimedSegmentEvidence[] {
  if (!/^\uFEFF?WEBVTT(?:\s|$)/u.test(text)) throw new MetadataError("metadata_unsupported");
  const blocks = text.replace(/^\uFEFF/u, "").split(/\n{2,}/u);
  const cues: TimedSegmentEvidence[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEndWithSettings] = lines[timingIndex].split(/\s+-->\s+/u);
    const rawEnd = rawEndWithSettings?.split(/\s+/u, 1)[0];
    const startSeconds = timestampSeconds(rawStart);
    const endSeconds = timestampSeconds(rawEnd);
    const cueText = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    if (startSeconds === undefined || endSeconds === undefined || startSeconds >= endSeconds || !cueText) {
      throw new MetadataError("metadata_unsupported");
    }
    cues.push({ id: `cue.${cues.length}`, kind: "timed", startSeconds, endSeconds, text: cueText });
  }
  if (cues.length === 0) throw new MetadataError("metadata_unsupported");
  return cues;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonText(value: unknown): string | undefined {
  const record = objectRecord(value);
  const candidate = record?.text ?? record?.transcript ?? record?.content;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function parseJsonTranscript(text: string): { text?: string; cues?: TimedSegmentEvidence[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MetadataError("metadata_unsupported");
  }
  const directText = jsonText(value);
  if (directText) return { text: directText };
  const record = objectRecord(value);
  const entries = Array.isArray(value)
    ? value
    : record?.segments ?? record?.cues ?? record?.items;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new MetadataError("metadata_unsupported");
  }

  if (entries.every((entry) => typeof entry === "string")) {
    return { text: entries.join("\n") };
  }

  const cues = entries.map((entry, index): TimedSegmentEvidence => {
    const item = objectRecord(entry);
    const cueText = item && jsonText(item);
    const startSeconds = item && timestampSeconds(item.startSeconds ?? item.start ?? item.offset);
    let endSeconds = item && timestampSeconds(item.endSeconds ?? item.end);
    const duration = item && timestampSeconds(item.durationSeconds ?? item.duration);
    if (endSeconds === undefined && startSeconds !== undefined && duration !== undefined) {
      endSeconds = startSeconds + duration;
    }
    if (!cueText || startSeconds === undefined || endSeconds === undefined || startSeconds >= endSeconds) {
      throw new MetadataError("metadata_unsupported");
    }
    return { id: `cue.${index}`, kind: "timed", startSeconds, endSeconds, text: cleanCueText(cueText) };
  });
  return { cues };
}

function textEvidence(content: string): TextSegmentEvidence[] {
  const result: TextSegmentEvidence[] = [];
  for (let start = 0; start < content.length; start += TEXT_CHUNK_SIZE) {
    const end = Math.min(content.length, start + TEXT_CHUNK_SIZE);
    result.push({ id: `text.${result.length}`, kind: "text", start, end, text: content.slice(start, end) });
  }
  if (result.length === 0) throw new MetadataError("metadata_unsupported");
  return result;
}

/** Retrieve and normalize a supported public transcript/text representation. */
export async function fetchSegmentMaterial(
  transcriptUrl: string,
  durationSeconds: number | null,
  options: MetadataFetchOptions = {},
): Promise<SegmentMaterial> {
  const maximumBytes = options.maximumBytes ?? configuredSegmentMaxBytes();
  const document = await fetchPublicDocument(transcriptUrl, [...SEGMENT_CONTENT_TYPES], {
    ...options,
    maximumBytes,
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(document.body).replace(/\r\n?/gu, "\n");
  } catch {
    throw new MetadataError("metadata_unsupported");
  }

  let representation: SegmentRepresentation;
  let content: string;
  let evidence: Array<TimedSegmentEvidence | TextSegmentEvidence>;
  if (document.contentType === "text/vtt") {
    representation = "timed";
    evidence = parseWebVtt(text);
    content = evidence.map((cue) => cue.text).join("\n");
  } else if (document.contentType === "application/json") {
    const parsed = parseJsonTranscript(text);
    if (parsed.cues) {
      representation = "timed";
      evidence = parsed.cues;
      content = parsed.cues.map((cue) => cue.text).join("\n");
    } else {
      representation = "text";
      content = parsed.text?.trim() ?? "";
      evidence = textEvidence(content);
    }
  } else {
    representation = "text";
    content = text.trim();
    evidence = textEvidence(content);
  }

  return {
    requestedUrl: transcriptUrl,
    finalUrl: document.finalUrl,
    contentType: document.contentType,
    sha256: createHash("sha256").update(document.body).digest("hex"),
    byteLength: document.body.byteLength,
    representation,
    durationSeconds,
    content,
    evidence,
  };
}
