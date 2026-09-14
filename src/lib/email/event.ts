import { timingSafeEqual } from "node:crypto";

import type { CaptureAttachment, ProviderNeutralCaptureInput } from "../capture/normalize";
import type { JsonValue } from "../capture/persist";

export const EMAIL_CHANNEL = "email";
export const REPRESENTATION_ROLE = "email_representation";
export const ATTACHMENT_ROLE = "email_attachment";
export const REPRESENTATION_FILENAME = "email.json";
export const REPRESENTATION_MEDIA_TYPE = "application/json";

/** Resend's `email.received` metadata. Everything here is provider-supplied, never trusted. */
export interface ResendAttachmentMetadata {
  id: string;
  filename?: string;
  contentType?: string;
  contentDisposition?: string;
  contentId?: string;
  size?: number;
}

export interface ReceivedEmailEvent {
  emailId: string;
  messageId?: string;
  subject?: string;
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  receivedFor: string[];
  createdAt?: string;
  attachments: ResendAttachmentMetadata[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function addresses(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function attachmentsFrom(value: unknown): ResendAttachmentMetadata[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    const attachment = record(entry);
    const id = attachment && text(attachment.id);
    if (!id) return [];

    return [{
      id,
      ...(text(attachment.filename) ? { filename: text(attachment.filename)! } : {}),
      ...(text(attachment.content_type) ? { contentType: text(attachment.content_type)! } : {}),
      ...(text(attachment.content_disposition)
        ? { contentDisposition: text(attachment.content_disposition)! }
        : {}),
      ...(text(attachment.content_id) ? { contentId: text(attachment.content_id)! } : {}),
      ...(typeof attachment.size === "number" && Number.isSafeInteger(attachment.size) && attachment.size >= 0
        ? { size: attachment.size }
        : {}),
    }];
  });
}

/**
 * Read the one event shape this endpoint acts on. Anything else — a different event type, a
 * payload with no email id — is not an inbound message and returns undefined rather than a
 * partially-populated object that later code would have to re-check.
 */
export function parseReceivedEmailEvent(payload: unknown): ReceivedEmailEvent | undefined {
  const event = record(payload);
  if (!event || event.type !== "email.received") return undefined;

  const data = record(event.data);
  const emailId = data && text(data.email_id);
  if (!data || !emailId) return undefined;

  return {
    emailId,
    ...(text(data.message_id) ? { messageId: text(data.message_id)! } : {}),
    ...(text(data.subject) ? { subject: text(data.subject)! } : {}),
    ...(text(data.from) ? { from: text(data.from)! } : {}),
    to: addresses(data.to),
    cc: addresses(data.cc),
    bcc: addresses(data.bcc),
    receivedFor: addresses(data.received_for),
    ...(text(data.created_at) ? { createdAt: text(data.created_at)! } : {}),
    attachments: attachmentsFrom(data.attachments),
  };
}

/** Compare on bytes, not on `===`, so a near-miss token cannot be found one character at a time. */
function tokenMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

/**
 * The local part of an address, lowercased and with any `+tag` suffix removed. Addresses arrive
 * from the network, so a value with no `@`, or with several, yields no local part at all.
 */
function localPart(address: string): string | undefined {
  const bare = /<([^<>]+)>\s*$/u.exec(address.trim())?.[1] ?? address.trim();
  const at = bare.lastIndexOf("@");
  if (at <= 0 || at === bare.length - 1) return undefined;

  return bare.slice(0, at).toLowerCase().split("+", 1)[0];
}

/** Every address the message was delivered to, including the forwarding `for` clause. */
export function isAddressedToToken(event: ReceivedEmailEvent, token: string): boolean {
  const expected = token.trim().toLowerCase();
  if (expected.length === 0) return false;

  return [...event.to, ...event.cc, ...event.bcc, ...event.receivedFor]
    .map(localPart)
    .some((candidate) => candidate !== undefined && tokenMatches(candidate, expected));
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;!?\]}]+$/u;

/** Every URL across the supplied parts, in encounter order, duplicates retained. */
export function extractUrlsInOrder(parts: readonly (string | undefined)[]): string[] {
  return parts.flatMap((part) =>
    part === undefined
      ? []
      : Array.from(part.matchAll(URL_PATTERN), ([match]) =>
          match.replace(TRAILING_URL_PUNCTUATION, ""),
        ).filter(Boolean),
  );
}

function attachmentAsset(
  attachment: ResendAttachmentMetadata,
  providerIndex: number,
): CaptureAttachment {
  return {
    role: ATTACHMENT_ROLE,
    id: attachment.id,
    fileName: attachment.filename ?? `attachment-${providerIndex + 1}`,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    ...(attachment.size === undefined ? {} : { sizeBytes: attachment.size }),
    providerIndex,
  };
}

/**
 * One inbound message becomes one capture. The first asset is a placeholder for the parsed
 * representation the enrichment job retrieves; the rest are the attachments Resend announced.
 * Both are created now so the whole email has a durable, addressable home before we acknowledge.
 */
export function toCaptureInput(
  event: ReceivedEmailEvent,
  signedPayload: JsonValue,
  capturedAt: string,
): ProviderNeutralCaptureInput & { rawProviderPayload: JsonValue } {
  const urls = extractUrlsInOrder([event.subject]);

  return {
    channel: EMAIL_CHANNEL,
    kind: "email",
    ...(event.subject === undefined ? {} : { rawText: event.subject }),
    externalMessageId: event.emailId,
    capturedAt,
    rawProviderPayload: {
      provider: "resend",
      event: signedPayload,
      emailId: event.emailId,
      messageId: event.messageId ?? null,
      subject: event.subject ?? null,
      from: event.from ?? null,
      to: event.to,
      cc: event.cc,
      bcc: event.bcc,
      receivedFor: event.receivedFor,
      attachments: event.attachments.map((attachment) => ({ ...attachment })),
      urls,
    },
    attachments: [
      {
        role: REPRESENTATION_ROLE,
        fileName: REPRESENTATION_FILENAME,
        contentType: REPRESENTATION_MEDIA_TYPE,
        providerIndex: -1,
      },
      ...event.attachments.map(attachmentAsset),
    ],
  };
}
