import { createHash } from "node:crypto";

export const DEFAULT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_TYPES)[number];
export function isImageType(value: string): value is ImageMediaType {
  return (IMAGE_TYPES as readonly string[]).includes(value);
}
export class MediaError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export interface MediaEvidence { mediaType: string; byteSize: number; sha256: string }
export interface DownloadedMedia extends MediaEvidence { bytes: Buffer }
export interface MediaConfiguration { accountSid: string; authToken: string; maxBytes: number }
export function configuredMedia(env: Record<string, string | undefined> = process.env): MediaConfiguration {
  const maxBytes = Number(env.CAPTURE_MEDIA_MAX_BYTES ?? DEFAULT_MEDIA_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024 ||
      !/^AC[0-9a-f]{32}$/iu.test(env.TWILIO_ACCOUNT_SID ?? "") || !env.TWILIO_AUTH_TOKEN?.trim()) {
    throw new MediaError("media_configuration_invalid");
  }
  return { accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN, maxBytes };
}
export function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
const mime = (value: string) => value.split(";", 1)[0].trim().toLowerCase();

/** Sniff inert binary formats. Unknown files are retained privately as octet-stream;
 * declared image/container signatures must match before anything reaches a model. */
function observedType(bytes: Buffer): string | undefined {
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  if (starts("89504e470d0a1a0a")) return "image/png";
  if (starts("ffd8ff")) return "image/jpeg";
  if (/^GIF8[79]a/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF") {
    if (bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  }
  if (bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (starts("1a45dfa3")) return "video/webm";
  if (starts("504b0304")) return "application/zip";
  if (starts("d0cf11e0a1b11ae1")) return "application/x-ole-storage";
  return undefined;
}
export function validateMedia(bytes: Buffer, declared: string, expected: string | null, maxBytes: number): DownloadedMedia {
  if (bytes.length > maxBytes) throw new MediaError("media_too_large");
  if (!bytes.length) throw new MediaError("media_mismatch");
  const mediaType = mime(declared);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType) ||
      ["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript"].includes(mediaType)) {
    throw new MediaError("unsafe_media");
  }
  if (expected && mime(expected) !== mediaType) throw new MediaError("media_mismatch");
  const observed = observedType(bytes);
  const compatible = observed === mediaType ||
    (observed === "video/mp4" && ["audio/mp4", "video/3gpp", "audio/3gpp"].includes(mediaType)) ||
    (observed === "video/webm" && mediaType === "audio/webm") ||
    (observed === "audio/wav" && mediaType === "audio/x-wav") ||
    (observed === "application/zip" && mediaType.startsWith("application/vnd.openxmlformats-officedocument.")) ||
    (observed === "application/x-ole-storage" && ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mediaType));
  // Opaque unsupported originals can be stored but are never advertised as analysed.
  const knownTypes = [...IMAGE_TYPES, "application/pdf", "audio/ogg", "audio/mpeg", "video/mp4", "audio/mp4", "video/webm", "audio/webm", "audio/wav", "audio/x-wav", "application/zip"];
  if (!compatible && mediaType !== "application/octet-stream" && (observed || knownTypes.includes(mediaType))) {
    throw new MediaError("media_mismatch");
  }
  if (/^\s*(?:<!doctype\s+html|<html|<script|<svg)/iu.test(bytes.subarray(0, 512).toString("utf8")) ||
      bytes.subarray(0, 2).toString() === "MZ" || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
    throw new MediaError("unsafe_media");
  }
  return { bytes, mediaType, byteSize: bytes.length, sha256: digest(bytes) };
}
function approvedUrl(raw: string, config: MediaConfiguration, redirect: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MediaError(redirect ? "unsafe_redirect" : "unsafe_origin"); }
  const apiPath = `/2010-04-01/Accounts/${config.accountSid}/Messages/`;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !(url.hostname === "mms.twiliocdn.com" || (url.hostname === "api.twilio.com" &&
        url.pathname.startsWith(apiPath) && /^(?:SM|MM)[0-9a-f]{32}\/Media\/ME[0-9a-f]{32}$/iu.test(url.pathname.slice(apiPath.length))))) {
    throw new MediaError(redirect ? "unsafe_redirect" : "unsafe_origin");
  }
  return url;
}
export async function downloadTwilioMedia(rawUrl: string, expected: string | null, config: MediaConfiguration,
  fetcher: typeof fetch = fetch): Promise<DownloadedMedia> {
  let url = approvedUrl(rawUrl, config, false);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    // CDN redirects use their signed URL. Never forward account credentials there.
    if (url.hostname === "api.twilio.com") headers.authorization = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;
    const response = await fetcher(url, { headers, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new MediaError("unsafe_redirect");
      let destination: string;
      try { destination = new URL(location, url).href; } catch { throw new MediaError("unsafe_redirect"); }
      url = approvedUrl(destination, config, true);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError(response.status === 404 || response.status === 410 ? "media_missing" : "media_unavailable");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > config.maxBytes)) {
      await response.body?.cancel(); throw new MediaError("media_too_large");
    }
    if (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") {
      await response.body?.cancel(); throw new MediaError("media_mismatch");
    }
    if (!response.body) throw new MediaError("media_mismatch");
    const reader = response.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > config.maxBytes) throw new MediaError("media_too_large");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    if (length !== null && size !== Number(length)) throw new MediaError("media_mismatch");
    return validateMedia(Buffer.concat(chunks), response.headers.get("content-type") ?? "", expected, config.maxBytes);
  }
  throw new MediaError("unsafe_redirect");
}
