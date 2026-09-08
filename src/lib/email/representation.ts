import type { JsonValue } from "../capture/persist";
import { extractUrlsInOrder, type ResendAttachmentMetadata } from "./event";

export const REPRESENTATION_VERSION = "resend-received-email-v1";

export interface StoredEmailRepresentation extends Record<string, JsonValue> {
  version: string;
  provider: string;
  emailId: string;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  receivedFor: string[];
  createdAt: string | null;
  text: string | null;
  html: string | null;
  htmlFormat: string | null;
  headers: Record<string, JsonValue>;
  attachments: Array<Record<string, JsonValue>>;
  urls: string[];
  retrievedAt: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function addresses(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function headerMap(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        ? [[key, entry] as [string, JsonValue]]
        : [],
    ),
  );
}

function attachmentMetadata(value: unknown): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const attachment = entry as Record<string, unknown>;
    if (typeof attachment.id !== "string") return [];

    return [{
      id: attachment.id,
      filename: text(attachment.filename),
      contentType: text(attachment.content_type),
      contentDisposition: text(attachment.content_disposition),
      contentId: text(attachment.content_id),
      size: typeof attachment.size === "number" ? attachment.size : null,
    }];
  });
}

/**
 * Build the durable record of the parsed email from Resend's response.
 *
 * This is an allow-list on purpose. Resend's payload also carries `raw.download_url` and, on the
 * attachments endpoint, a per-attachment `download_url`: short-lived signed URLs that grant
 * anyone holding them the content. Copying those into a capture row would turn an expiring
 * credential into durable stored content, so nothing URL-shaped from the provider is carried
 * over — only the bytes themselves, into private storage.
 */
export function buildStoredRepresentation(
  emailId: string,
  response: Record<string, unknown>,
  retrievedAt: string,
): StoredEmailRepresentation {
  const body = text(response.text);
  const html = text(response.html);
  const subject = text(response.subject);

  return {
    version: REPRESENTATION_VERSION,
    provider: "resend",
    emailId,
    messageId: text(response.message_id),
    subject,
    from: text(response.from),
    to: addresses(response.to),
    cc: addresses(response.cc),
    bcc: addresses(response.bcc),
    replyTo: addresses(response.reply_to),
    receivedFor: addresses(response.received_for),
    createdAt: text(response.created_at),
    text: body,
    html,
    htmlFormat: text(response.html_format),
    headers: headerMap(response.headers),
    attachments: attachmentMetadata(response.attachments),
    urls: extractUrlsInOrder([subject ?? undefined, body ?? undefined, html ?? undefined]),
    retrievedAt,
  };
}

export function serializeRepresentation(representation: StoredEmailRepresentation): Buffer {
  return Buffer.from(JSON.stringify(representation), "utf8");
}

export interface RepresentationExcerpt extends Record<string, JsonValue> {
  subject: string | null;
  text: string | null;
  textTruncated: boolean;
  htmlPresent: boolean;
  urls: string[];
  headerKeys: string[];
  attachmentCount: number;
}

export const EXCERPT_TEXT_LIMIT = 32 * 1024;
export const EXCERPT_URL_LIMIT = 100;

/**
 * The part of a stored email a model is allowed to see.
 *
 * Sender and recipient addresses are deliberately absent: they identify people, they are not
 * evidence of why something was saved, and the intent snapshot is stored verbatim next to every
 * run. Header *names* are kept because "this was a list mailing" is real evidence; header
 * *values* are not, because that is where the addresses live.
 */
export function representationExcerpt(
  representation: StoredEmailRepresentation,
): RepresentationExcerpt {
  const body = representation.text ?? null;

  return {
    subject: representation.subject,
    text: body === null ? null : body.slice(0, EXCERPT_TEXT_LIMIT),
    textTruncated: body !== null && body.length > EXCERPT_TEXT_LIMIT,
    htmlPresent: representation.html !== null,
    urls: representation.urls.slice(0, EXCERPT_URL_LIMIT),
    headerKeys: Object.keys(representation.headers).sort(),
    attachmentCount: representation.attachments.length,
  };
}

export function parseStoredRepresentation(bytes: Buffer): StoredEmailRepresentation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== REPRESENTATION_VERSION) return undefined;

  return candidate as StoredEmailRepresentation;
}

export type { ResendAttachmentMetadata };
