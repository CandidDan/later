import { normalizeCaptureInput } from "./normalize";
import type { JsonValue, PersistCaptureInput, PersistCaptureResult } from "./persist";
import type { ResearchSession } from "../research/types";

/**
 * Captures shared from the iPhone app. The owner is only ever the verified session's user: the
 * body is checked against a closed set of keys, so nothing a client sends can name one.
 */
export interface AppShareDependencies {
  authenticate(request: Request): Promise<ResearchSession | undefined>;
  persist(input: PersistCaptureInput): Promise<PersistCaptureResult>;
  now?(): Date;
}

export interface AppShareBody {
  requestId: string;
  url?: string;
  text?: string;
  note?: string;
  sharedAt?: string;
}

export const APP_SHARE_CHANNEL = "ios_share";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_URL_LENGTH = 2000;
export const MAX_TEXT_LENGTH = 16000;

const ALLOWED_KEYS = new Set(["requestId", "url", "text", "note", "sharedAt"]);
const headers = { "Cache-Control": "private, no-store", "Vary": "Authorization", "X-Content-Type-Options": "nosniff" };
const ERRORS = { 400: "Invalid", 401: "Unauthorized", 503: "Unavailable" } as const;
const failure = (status: keyof typeof ERRORS) => Response.json({ error: ERRORS[status] }, { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isAbsoluteHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /\s/u.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const optionalString = (value: unknown, valid: (text: string) => boolean) =>
  value === undefined || (typeof value === "string" && valid(value));

/** The body, or undefined when its shape is anything other than exactly what the app sends. */
export function parseAppShareBody(input: unknown): AppShareBody | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return undefined;
  if (!optionalString(body.url, isAbsoluteHttpUrl)) return undefined;
  if (!optionalString(body.text, (text) => text.length <= MAX_TEXT_LENGTH)) return undefined;
  if (!optionalString(body.note, (note) => note.length <= MAX_TEXT_LENGTH)) return undefined;
  if (!optionalString(body.sharedAt, (at) => ISO_DATETIME.test(at) && !Number.isNaN(Date.parse(at)))) {
    return undefined;
  }
  const hasText = typeof body.text === "string" && body.text.trim().length > 0;
  if (body.url === undefined && !hasText) return undefined;
  return body as unknown as AppShareBody;
}

/** Read at most `limit` bytes; undefined when the body is larger, so it is never buffered whole. */
async function readCappedText(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The url and text exactly as one WhatsApp message would carry them, for the normaliser. */
export function appShareRawText(body: Pick<AppShareBody, "url" | "text">): string {
  return [body.url, body.text].filter((part) => part !== undefined && part.length > 0).join("\n");
}

export async function handleAppCapture(request: Request, deps: AppShareDependencies): Promise<Response> {
  try {
    const session = await deps.authenticate(request);
    if (!session) return failure(401);

    const raw = await readCappedText(request, MAX_BODY_BYTES);
    if (raw === undefined) return failure(400);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return failure(400); }
    const body = parseAppShareBody(parsed);
    if (!body) return failure(400);

    const capture = normalizeCaptureInput({
      channel: APP_SHARE_CHANNEL,
      rawText: appShareRawText(body),
      userNote: body.note,
      externalMessageId: body.requestId,
      capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
      rawProviderPayload: body,
      attachments: [],
    });
    const result = await deps.persist({
      userId: session.userId,
      capture: {
        ...capture,
        channel: APP_SHARE_CHANNEL,
        capturedAt: capture.capturedAt!,
        rawProviderPayload: body as unknown as JsonValue,
      },
    });

    return Response.json(
      { captureId: result.captureId, repeated: !result.created },
      { status: result.created ? 201 : 200, headers },
    );
  } catch {
    return failure(503);
  }
}
