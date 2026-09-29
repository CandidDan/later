import type { PublicMetadata } from "./input";
import {
  boundedMetadataText,
  DEFAULT_METADATA_MAX_BYTES,
  fetchPublicDocument,
  fetchPublicMetadata,
  MetadataError,
  type MetadataFetchOptions,
} from "./metadata";
import { recognizeSource } from "./recognized";

/**
 * The only YouTube surface Later retrieves. It is a fixed module constant, never a value
 * discovered from captured content, and it serves a small JSON document instead of the
 * multi-megabyte watch application page.
 */
export const YOUTUBE_OEMBED_ORIGIN = "https://www.youtube.com";
export const YOUTUBE_OEMBED_PATH = "/oembed";

/** oEmbed JSON for one video is a few hundred bytes; keep the ceiling far below the generic one. */
export const YOUTUBE_OEMBED_MAX_BYTES = 16 * 1024;
const YOUTUBE_OEMBED_CONTENT_TYPES = ["application/json"] as const;

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const INSTAGRAM_POST_KINDS = new Set(["p", "reel", "reels", "tv"]);
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/u;

/** Upstream statuses that are worth another bounded attempt rather than a permanent verdict. */
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export type PlatformMetadataRoute =
  | { platform: "youtube"; supported: true; canonicalUrl: string; endpointUrl: string }
  | {
      platform: "instagram";
      supported: false;
      canonicalUrl: string;
      notice: "metadata_unsupported_platform";
    };

function youtubeOembedUrl(canonicalUrl: string): string {
  const endpoint = new URL(YOUTUBE_OEMBED_PATH, YOUTUBE_OEMBED_ORIGIN);
  endpoint.searchParams.set("url", canonicalUrl);
  endpoint.searchParams.set("format", "json");
  return endpoint.href;
}

function instagramRoute(url: URL): PlatformMetadataRoute | undefined {
  if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  // Tracking parameters and fragments are dropped: they identify the recipient, not the post.
  const canonicalUrl = kind !== undefined && INSTAGRAM_POST_KINDS.has(kind.toLowerCase())
      && id !== undefined && INSTAGRAM_SHORTCODE.test(id)
    ? `https://www.instagram.com/${kind.toLowerCase()}/${id}/`
    : `https://www.instagram.com${url.pathname}`;
  return {
    platform: "instagram",
    supported: false,
    canonicalUrl,
    notice: "metadata_unsupported_platform",
  };
}

/**
 * Decide, from the URL alone, whether a captured link has explicit platform metadata behaviour.
 * `undefined` means "ordinary public page" and leaves the generic SSRF-safe path untouched.
 */
export function platformMetadataRoute(rawUrl: string): PlatformMetadataRoute | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;

  const recognized = recognizeSource(rawUrl);
  if (recognized?.sourceType === "youtube_video") {
    return {
      platform: "youtube",
      supported: true,
      canonicalUrl: recognized.canonicalUrl,
      endpointUrl: youtubeOembedUrl(recognized.canonicalUrl),
    };
  }
  return instagramRoute(url);
}

/**
 * Re-code a bounded-fetch failure for a platform endpoint. A client rejection (a removed or
 * private video) is permanent and must not burn three attempts; an outage, throttle or timeout
 * keeps the existing retryable category. Only allow-listed codes leave this function.
 */
function platformFailure(error: unknown): MetadataError {
  if (!(error instanceof MetadataError)) return new MetadataError("metadata_unavailable");
  const { status } = error;
  if (error.code === "metadata_unavailable" && status !== undefined
      && status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status)) {
    return new MetadataError("metadata_unsupported");
  }
  return error;
}

async function fetchYoutubeOembedMetadata(
  route: Extract<PlatformMetadataRoute, { platform: "youtube" }>,
  options: MetadataFetchOptions,
): Promise<PublicMetadata> {
  let body: Uint8Array;
  try {
    const document = await fetchPublicDocument(route.endpointUrl, [...YOUTUBE_OEMBED_CONTENT_TYPES], {
      ...options,
      maximumBytes: Math.min(
        options.maximumBytes ?? DEFAULT_METADATA_MAX_BYTES,
        YOUTUBE_OEMBED_MAX_BYTES,
      ),
    });
    body = document.body;
  } catch (error) {
    throw platformFailure(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new MetadataError("metadata_unsupported");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MetadataError("metadata_unsupported");
  }
  // Only these two fields are read. Embed HTML, thumbnails and dimensions are ignored entirely,
  // and the canonical URL comes from Later's own derivation rather than the response.
  const record = parsed as Record<string, unknown>;
  const title = boundedMetadataText(record.title);
  const creator = boundedMetadataText(record.author_name);
  if (title === undefined || creator === undefined) {
    throw new MetadataError("metadata_unsupported");
  }
  return {
    requestedUrl: route.canonicalUrl,
    finalUrl: route.canonicalUrl,
    contentType: "application/json",
    title,
    creator,
    canonicalUrl: route.canonicalUrl,
  };
}

/**
 * Retrieve bounded metadata for a captured URL, preferring an explicit platform surface where
 * one exists. Platforms without an approved retrieval surface fail permanently and are never
 * requested; everything else keeps the generic SSRF-safe fetch and reduction unchanged.
 */
export async function fetchPlatformAwareMetadata(
  rawUrl: string,
  options: MetadataFetchOptions = {},
): Promise<PublicMetadata> {
  const route = platformMetadataRoute(rawUrl);
  if (route === undefined) return fetchPublicMetadata(rawUrl, options);
  if (!route.supported) throw new MetadataError(route.notice);
  return fetchYoutubeOembedMetadata(route, options);
}
