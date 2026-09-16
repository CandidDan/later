import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { PublicMetadata } from "./input";

export const DEFAULT_METADATA_MAX_BYTES = 128 * 1024;
export const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
export const MAX_METADATA_REDIRECTS = 3;
const SUPPORTED_CONTENT_TYPES = new Set([
  "text/html",
  "application/json",
  "application/ld+json",
]);

export const SEGMENT_CONTENT_TYPES = [
  "text/plain",
  "text/vtt",
  "application/json",
] as const;

export type MetadataErrorCode =
  | "unsafe_url"
  | "unsafe_redirect"
  | "metadata_unsupported"
  | "metadata_too_large"
  | "metadata_unavailable";

export class MetadataError extends Error {
  constructor(readonly code: MetadataErrorCode) {
    super(code);
    this.name = "MetadataError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface MetadataResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface MetadataRequest {
  (
    url: URL,
    addresses: readonly ResolvedAddress[],
    maximumBytes: number,
    timeoutMs: number,
  ): Promise<MetadataResponse>;
}

export interface MetadataFetchOptions {
  resolveHostname?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: MetadataRequest;
  maximumBytes?: number;
  timeoutMs?: number;
  maximumRedirects?: number;
}

export interface PublicDocument {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
}

function unsafeIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 192 && b === 88)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224;
}

function unsafeIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  // Public IPv6 unicast is 2000::/3. Conservatively reject transition, mapped, local,
  // documentation and other special-use ranges instead of trying to enumerate them.
  const first = Number.parseInt(normalized.split(":", 1)[0], 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  return false;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !unsafeIpv4(address) : family === 6 ? !unsafeIpv6(address) : false;
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

async function resolvePublicHttpsUrl(
  raw: string,
  resolver: (hostname: string) => Promise<readonly ResolvedAddress[]>,
  redirect: boolean,
): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MetadataError(redirect ? "unsafe_redirect" : "unsafe_url");
  }
  const hostname = url.hostname.toLowerCase();
  const resolverHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new MetadataError(redirect ? "unsafe_redirect" : "unsafe_url");
  }
  if (isIP(resolverHostname) && !isPublicAddress(resolverHostname)) {
    throw new MetadataError(redirect ? "unsafe_redirect" : "unsafe_url");
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(resolverHostname);
  } catch {
    throw new MetadataError("metadata_unavailable");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new MetadataError(redirect ? "unsafe_redirect" : "unsafe_url");
  }
  return { url, addresses };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const defaultRequest: MetadataRequest = (url, addresses, maximumBytes, timeoutMs) => new Promise((resolve, reject) => {
  const selected = addresses[0];
  const request = httpsRequest({
    protocol: "https:",
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      accept: "text/html, text/plain, text/vtt, application/json, application/ld+json",
      "accept-encoding": "identity",
      "user-agent": "LaterSourceResolver/1.0",
    },
    servername: url.hostname,
    lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
  }, (response) => {
    const status = response.statusCode ?? 0;
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name, headerValue(value)]),
    );
    const contentLength = Number(headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      response.destroy();
      reject(new MetadataError("metadata_too_large"));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        response.destroy(new MetadataError("metadata_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
    response.on("error", reject);
  });
  request.setTimeout(timeoutMs, () => request.destroy(new MetadataError("metadata_unavailable")));
  request.on("error", reject);
  request.end();
});

function normalizedContentType(
  header: string | undefined,
  supported: ReadonlySet<string>,
): string {
  const contentType = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !supported.has(contentType)) {
    throw new MetadataError("metadata_unsupported");
  }
  return contentType;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 500) : undefined;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function htmlValues(html: string): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attrs = attributes(tag);
    const name = (attrs.property ?? attrs.name)?.toLowerCase();
    if (name && attrs.content !== undefined) values[name] = attrs.content;
  }
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const attrs = attributes(tag);
    const rel = attrs.rel?.toLowerCase();
    if (rel === "canonical" && attrs.href) values.canonical = attrs.href;
    if ((rel === "transcript" || attrs.type === "text/vtt") && attrs.href) values.transcript = attrs.href;
  }
  values.documentTitle = /<title\b[^>]*>([^<]*)<\/title>/iu.exec(html)?.[1];
  return values;
}

function jsonValues(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MetadataError("metadata_unsupported");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MetadataError("metadata_unsupported");
  }
  return parsed as Record<string, unknown>;
}

async function safeDiscoveredUrl(
  raw: unknown,
  base: URL,
  resolver: (hostname: string) => Promise<readonly ResolvedAddress[]>,
): Promise<string | undefined> {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  let absolute: string;
  try {
    absolute = new URL(raw, base).href;
  } catch {
    return undefined;
  }
  try {
    return (await resolvePublicHttpsUrl(absolute, resolver, true)).url.href;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a public HTTPS document through the resolver's single SSRF-safe boundary. DNS is
 * pinned for each request and repeated after redirects; time, redirects and bytes are bounded.
 */
export async function fetchPublicDocument(
  rawUrl: string,
  supportedContentTypes: readonly string[],
  options: MetadataFetchOptions = {},
): Promise<PublicDocument> {
  const resolver = options.resolveHostname ?? defaultResolver;
  const request = options.request ?? defaultRequest;
  const maximumBytes = options.maximumBytes ?? DEFAULT_METADATA_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const maximumRedirects = options.maximumRedirects ?? MAX_METADATA_REDIRECTS;
  let destination = rawUrl;
  let resolved: Awaited<ReturnType<typeof resolvePublicHttpsUrl>> | undefined;
  let response: MetadataResponse | undefined;

  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    resolved = await resolvePublicHttpsUrl(destination, resolver, redirects > 0);
    try {
      response = await request(resolved.url, resolved.addresses, maximumBytes, timeoutMs);
    } catch (error) {
      if (error instanceof MetadataError) throw error;
      throw new MetadataError("metadata_unavailable");
    }
    if (response.body.byteLength > maximumBytes) throw new MetadataError("metadata_too_large");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirects === maximumRedirects) throw new MetadataError("unsafe_redirect");
      destination = new URL(location, resolved.url).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new MetadataError("metadata_unavailable");
    break;
  }
  if (!resolved || !response) throw new MetadataError("metadata_unavailable");
  const contentType = normalizedContentType(
    response.headers["content-type"],
    new Set(supportedContentTypes),
  );
  return {
    requestedUrl: rawUrl,
    finalUrl: resolved.url.href,
    contentType,
    body: response.body,
  };
}

/** Fetch and reduce a public document to bounded metadata; raw response content is never returned. */
export async function fetchPublicMetadata(
  rawUrl: string,
  options: MetadataFetchOptions = {},
): Promise<PublicMetadata> {
  const resolver = options.resolveHostname ?? defaultResolver;
  const document = await fetchPublicDocument(rawUrl, [...SUPPORTED_CONTENT_TYPES], {
    ...options,
    resolveHostname: resolver,
  });
  const contentType = document.contentType as PublicMetadata["contentType"];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(document.body);
  const values = contentType === "text/html" ? htmlValues(text) : jsonValues(text);
  const title = cleanText(values["og:title"] ?? values.title ?? values.documentTitle);
  const creatorValue = values.author_name ?? values.author ?? values.creator;
  const creator = cleanText(
    creatorValue !== null && typeof creatorValue === "object" && !Array.isArray(creatorValue)
      ? (creatorValue as Record<string, unknown>).name
      : creatorValue,
  );
  const canonicalUrl = await safeDiscoveredUrl(
    values["og:url"] ?? values.canonical ?? values.canonical_url ?? values.url,
    new URL(document.finalUrl),
    resolver,
  );
  const transcriptUrl = await safeDiscoveredUrl(
    values.transcript ?? values.transcript_url,
    new URL(document.finalUrl),
    resolver,
  );
  const durationValue = values["video:duration"] ?? values.duration_seconds ?? values.duration;
  const duration = typeof durationValue === "number" ? durationValue : Number(durationValue);
  const durationSeconds = Number.isInteger(duration) && duration > 0 ? duration : undefined;

  return {
    requestedUrl: rawUrl,
    finalUrl: document.finalUrl,
    contentType,
    ...(title === undefined ? {} : { title }),
    ...(creator === undefined ? {} : { creator }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(transcriptUrl === undefined ? {} : { transcriptUrl }),
  };
}
