import { MediaError, validateMedia, type DownloadedMedia } from "../assets/media";
import { EmailError, type EmailRetrievalConfiguration } from "./config";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/**
 * Attachment bytes come from a signed CDN URL Resend hands us, so the destination is checked
 * rather than assumed: HTTPS only, a Resend host, no embedded credentials. The URL is also a
 * bearer credential in its own right, which is why it is downloaded and then discarded — see
 * `representation.ts` for what actually gets stored.
 */
function approvedDownloadUrl(raw: string, redirect: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmailError(redirect ? "unsafe_redirect" : "unsafe_origin");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !(host === "resend.com" || host.endsWith(".resend.com"))
  ) {
    throw new EmailError(redirect ? "unsafe_redirect" : "unsafe_origin");
  }

  return url;
}

function failureCode(status: number): string {
  if (status === 404 || status === 410) return "email_missing";
  if (status === 401 || status === 403) return "email_forbidden";
  return "email_unavailable";
}

/** Read a response body under a hard ceiling, so a hostile length header cannot exhaust memory. */
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw new EmailError("email_too_large");
  }

  if (!response.body) throw new EmailError("email_unavailable");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new EmailError("email_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }

  return Buffer.concat(chunks);
}

async function getJson(
  path: string,
  config: EmailRetrievalConfiguration,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${config.apiBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new EmailError(failureCode(response.status));
  }

  const body = await boundedBody(response, config.maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new EmailError("email_response_invalid");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EmailError("email_response_invalid");
  }

  return parsed as Record<string, unknown>;
}

export interface ResendAttachmentDownload {
  id: string;
  filename?: string;
  contentType?: string;
  contentDisposition?: string;
  contentId?: string;
  size?: number;
  downloadUrl: string;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function retrieveReceivedEmail(
  emailId: string,
  config: EmailRetrievalConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  return getJson(`/emails/receiving/${encodeURIComponent(emailId)}`, config, fetcher);
}

export async function listReceivedEmailAttachments(
  emailId: string,
  config: EmailRetrievalConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<ResendAttachmentDownload[]> {
  const body = await getJson(
    `/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
    config,
    fetcher,
  );

  if (!Array.isArray(body.data)) throw new EmailError("email_response_invalid");

  return body.data.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const attachment = entry as Record<string, unknown>;
    const id = optionalText(attachment.id);
    const downloadUrl = optionalText(attachment.download_url);
    if (!id || !downloadUrl) return [];

    return [{
      id,
      downloadUrl,
      ...(optionalText(attachment.filename) ? { filename: optionalText(attachment.filename)! } : {}),
      ...(optionalText(attachment.content_type)
        ? { contentType: optionalText(attachment.content_type)! }
        : {}),
      ...(optionalText(attachment.content_disposition)
        ? { contentDisposition: optionalText(attachment.content_disposition)! }
        : {}),
      ...(optionalText(attachment.content_id) ? { contentId: optionalText(attachment.content_id)! } : {}),
      ...(typeof attachment.size === "number" && Number.isSafeInteger(attachment.size)
        ? { size: attachment.size }
        : {}),
    }];
  });
}

/**
 * Fetch one attachment's original bytes. The signed URL is never given the API key, redirects
 * are followed manually and re-checked against the same host rule, and the bytes go through the
 * same validation the WhatsApp media path uses before anything is stored.
 */
export async function downloadAttachment(
  rawUrl: string,
  expectedType: string | null,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
): Promise<DownloadedMedia> {
  let url = approvedDownloadUrl(rawUrl, false);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(url, {
      headers: { "accept-encoding": "identity" },
      redirect: "manual",
      signal,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new EmailError("unsafe_redirect");

      let destination: string;
      try {
        destination = new URL(location, url).href;
      } catch {
        throw new EmailError("unsafe_redirect");
      }
      url = approvedDownloadUrl(destination, true);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new EmailError(failureCode(response.status));
    }

    if (
      response.headers.has("content-encoding") &&
      response.headers.get("content-encoding") !== "identity"
    ) {
      await response.body?.cancel();
      throw new EmailError("media_mismatch");
    }

    const length = response.headers.get("content-length");
    const bytes = await boundedBody(response, maxBytes);
    if (length !== null && bytes.length !== Number(length)) throw new EmailError("media_mismatch");

    try {
      return validateMedia(
        bytes,
        response.headers.get("content-type") ?? expectedType ?? "application/octet-stream",
        expectedType,
        maxBytes,
      );
    } catch (error) {
      throw error instanceof MediaError ? new EmailError(error.code) : error;
    }
  }

  throw new EmailError("unsafe_redirect");
}
