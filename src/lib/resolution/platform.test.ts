import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_METADATA_MAX_BYTES,
  METADATA_ERROR_CODES,
  MetadataError,
  type MetadataRequest,
  type MetadataResponse,
} from "./metadata";
import {
  fetchPlatformAwareMetadata,
  platformMetadataRoute,
  YOUTUBE_OEMBED_MAX_BYTES,
} from "./platform";

const VIDEO_ID = "publicVideo1";
const CANONICAL_VIDEO = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const OEMBED_BODY = JSON.stringify({
  title: "A Public Talk",
  author_name: "Public Channel",
  author_url: "https://www.youtube.com/@public",
  thumbnail_url: "https://i.ytimg.com/vi/thumb.jpg",
  html: "<iframe src=\"https://www.youtube.com/embed/x\"></iframe>",
  width: 200,
  height: 113,
  provider_name: "YouTube",
  type: "video",
  version: "1.0",
});

const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

function response(
  body: string,
  contentType = "application/json; charset=utf-8",
  status = 200,
  extraHeaders: Record<string, string> = {},
): MetadataResponse {
  return {
    status,
    headers: { "content-type": contentType, ...extraHeaders },
    body: new TextEncoder().encode(body),
  };
}

function requestedPaths(request: { mock: { calls: Array<[URL, ...unknown[]]> } }): string[] {
  return request.mock.calls.map(([url]) => url.pathname);
}

/** Await a retrieval that must fail, and narrow the rejection to the allow-listed error type. */
async function rejection(promise: Promise<unknown>): Promise<MetadataError> {
  const outcome = await promise.then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(MetadataError);
  return outcome as MetadataError;
}

describe("platform-aware metadata routing", () => {
  it.each([
    ["desktop watch URL", `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42`],
    ["bare host watch URL", `https://youtube.com/watch?v=${VIDEO_ID}`],
    ["mobile watch URL", `https://m.youtube.com/watch?v=${VIDEO_ID}`],
    ["short share URL", `https://youtu.be/${VIDEO_ID}?si=tracking`],
  ])("AC1 requests only the fixed oEmbed endpoint for a %s and never the watch page", async (_label, rawUrl) => {
    const request = vi.fn<MetadataRequest>(async () => response(OEMBED_BODY));
    await fetchPlatformAwareMetadata(rawUrl, { resolveHostname: publicResolver, request });

    expect(request).toHaveBeenCalledTimes(1);
    expect(requestedPaths(request)).toStrictEqual(["/oembed"]);
    expect(requestedPaths(request)).not.toContain("/watch");
    const [endpoint] = request.mock.calls[0];
    expect(endpoint.origin).toBe("https://www.youtube.com");
    expect(endpoint.searchParams.get("url")).toBe(CANONICAL_VIDEO);
    expect(endpoint.searchParams.get("format")).toBe("json");
  });

  it("AC1 bounds the oEmbed request well below the generic document ceiling", async () => {
    const request = vi.fn<MetadataRequest>(async () => response(OEMBED_BODY));
    await fetchPlatformAwareMetadata(CANONICAL_VIDEO, { resolveHostname: publicResolver, request });

    expect(request.mock.calls[0][2]).toBe(YOUTUBE_OEMBED_MAX_BYTES);
    expect(YOUTUBE_OEMBED_MAX_BYTES).toBeLessThan(DEFAULT_METADATA_MAX_BYTES);
  });

  it.each([
    "https://www.youtube.com/watch?v=publicVideo1",
    "https://example.com/oembed",
  ])("AC1/AC3 rejects a public redirect to %s without leaving the fixed endpoint", async (location) => {
    const request = vi.fn<MetadataRequest>(async () => response("", "application/json", 302, { location }));
    await expect(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request,
      maximumRedirects: 5,
    })).rejects.toMatchObject({ code: "unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestedPaths(request)).toStrictEqual(["/oembed"]);
  });

  it("AC2 maps only the oEmbed title and author onto the canonical video identity", async () => {
    const request = vi.fn<MetadataRequest>(async () => response(OEMBED_BODY));
    const metadata = await fetchPlatformAwareMetadata(`https://youtu.be/${VIDEO_ID}`, {
      resolveHostname: publicResolver,
      request,
    });

    expect(metadata).toStrictEqual({
      requestedUrl: CANONICAL_VIDEO,
      finalUrl: CANONICAL_VIDEO,
      contentType: "application/json",
      title: "A Public Talk",
      creator: "Public Channel",
      canonicalUrl: CANONICAL_VIDEO,
    });
    // Embed HTML, thumbnails and dimensions are ignored rather than reduced.
    expect(JSON.stringify(metadata)).not.toContain("iframe");
    expect(JSON.stringify(metadata)).not.toContain("ytimg");
  });

  it.each([
    ["malformed JSON", response("{not json")],
    ["a JSON array", response("[{\"title\":\"x\"}]")],
    ["a JSON scalar", response("\"just a string\"")],
    ["invalid UTF-8", { status: 200, headers: { "content-type": "application/json" }, body: new Uint8Array([0xff, 0xfe]) }],
    ["an unsupported content type", response(OEMBED_BODY, "text/html")],
    ["a response missing the author", response(JSON.stringify({ title: "A Public Talk" }))],
    ["a response missing the title", response(JSON.stringify({ author_name: "Public Channel" }))],
    ["a removed video", response("{}", "application/json", 404)],
    ["a private video", response("{}", "application/json", 401)],
  ])("AC3 turns %s into a non-retryable allow-listed code", async (_label, result) => {
    const request = vi.fn<MetadataRequest>(async () => result as MetadataResponse);
    const { code } = await rejection(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request,
    }));

    expect(METADATA_ERROR_CODES).toContain(code);
    expect(code).not.toBe("metadata_unavailable");
  });

  it("AC3 rejects an oversized oEmbed response before it can be parsed", async () => {
    const request = vi.fn<MetadataRequest>(async () => response("x".repeat(64)));
    await expect(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request,
      maximumBytes: 32,
    })).rejects.toMatchObject({ code: "metadata_too_large" });
  });

  it("AC3 rejects an oEmbed redirect to a private address before a second connection", async () => {
    const request = vi.fn<MetadataRequest>(async () => response("", "application/json", 302, {
      location: "https://metadata.internal/oembed",
    }));
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === "metadata.internal" ? "169.254.169.254" : "93.184.216.34",
      family: 4 as const,
    }]);

    await expect(fetchPlatformAwareMetadata(CANONICAL_VIDEO, { resolveHostname: resolver, request }))
      .rejects.toMatchObject({ code: "unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", async () => { throw new MetadataError("metadata_unavailable"); }],
    ["a rate limit", async () => response("{}", "application/json", 429)],
    ["a server failure", async () => response("{}", "application/json", 503)],
    ["a gateway failure", async () => response("{}", "application/json", 502)],
  ])("AC4 keeps %s in the retryable metadata_unavailable category", async (_label, handler) => {
    await expect(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request: handler as MetadataRequest,
    })).rejects.toMatchObject({ code: "metadata_unavailable" });
  });

  it("AC4/AC7 re-codes an unexpected transport error as retryable without surfacing its text", async () => {
    const request = vi.fn<MetadataRequest>(async () => { throw new Error("private socket detail"); });
    const error = await rejection(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request,
    }));

    expect(error.code).toBe("metadata_unavailable");
    expect(error.message).not.toContain("private socket detail");
  });

  it("AC4 keeps a DNS failure for the metadata endpoint retryable", async () => {
    const request = vi.fn<MetadataRequest>();
    await expect(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: async () => { throw new Error("private resolver detail"); },
      request,
    })).rejects.toMatchObject({ code: "metadata_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["reel", "https://www.instagram.com/reel/AbC-d_123/?igsh=trackingvalue", "https://www.instagram.com/reel/AbC-d_123/"],
    ["post", "https://instagram.com/p/AbC-d_123?utm_source=whatsapp#comments", "https://www.instagram.com/p/AbC-d_123/"],
    ["tv", "https://m.instagram.com/tv/AbC-d_123/?igshid=x", "https://www.instagram.com/tv/AbC-d_123/"],
  ])("AC5 canonicalises an Instagram %s URL and never requests the application page", async (_label, rawUrl, canonicalUrl) => {
    expect(platformMetadataRoute(rawUrl)).toStrictEqual({
      platform: "instagram",
      supported: false,
      canonicalUrl,
      notice: "metadata_unsupported_platform",
    });

    const request = vi.fn<MetadataRequest>();
    const resolveHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    await expect(fetchPlatformAwareMetadata(rawUrl, { resolveHostname, request }))
      .rejects.toMatchObject({ code: "metadata_unsupported_platform" });
    expect(request).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("AC5 treats a non-post Instagram URL as unsupported and strips its query and fragment", async () => {
    expect(platformMetadataRoute("https://www.instagram.com/some.creator/?hl=en#bio")).toStrictEqual({
      platform: "instagram",
      supported: false,
      canonicalUrl: "https://www.instagram.com/some.creator/",
      notice: "metadata_unsupported_platform",
    });

    const request = vi.fn<MetadataRequest>();
    await expect(fetchPlatformAwareMetadata("https://www.instagram.com/some.creator/?hl=en", {
      resolveHostname: publicResolver,
      request,
    })).rejects.toMatchObject({ code: "metadata_unsupported_platform" });
    expect(request).not.toHaveBeenCalled();
  });

  it("AC5 treats the unsupported-platform notice as allow-listed and non-retryable", async () => {
    const error = await rejection(fetchPlatformAwareMetadata("https://www.instagram.com/reel/AbC-d_123/"));
    expect(METADATA_ERROR_CODES).toContain(error.code);
    expect(error.code).not.toBe("metadata_unavailable");
  });

  it.each([
    "https://example.com/article",
    "https://podcasts.example/episodes/source",
    "https://open.spotify.com/episode/0123456789abcdef",
  ])("AC6 leaves %s on the unchanged generic path", async (rawUrl) => {
    expect(platformMetadataRoute(rawUrl)).toBeUndefined();

    const request = vi.fn<MetadataRequest>(async () => response(`
      <meta property="og:title" content="The Source Episode">
      <meta name="author" content="Ada Example">
    `, "text/html; charset=utf-8"));
    const metadata = await fetchPlatformAwareMetadata(rawUrl, {
      resolveHostname: publicResolver,
      request,
    });

    expect(metadata).toStrictEqual({
      requestedUrl: rawUrl,
      finalUrl: rawUrl,
      contentType: "text/html",
      title: "The Source Episode",
      creator: "Ada Example",
    });
    expect(request.mock.calls[0][2]).toBe(DEFAULT_METADATA_MAX_BYTES);
  });

  it("AC6 keeps generic SSRF rejection in place for a non-platform destination", async () => {
    const request = vi.fn<MetadataRequest>();
    await expect(fetchPlatformAwareMetadata("http://example.com/article", {
      resolveHostname: publicResolver,
      request,
    })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(request).not.toHaveBeenCalled();
  });

  it("AC6 ignores platform look-alike hosts and credentialed URLs", () => {
    for (const rawUrl of [
      "https://youtube.com.evil.example/watch?v=publicVideo1",
      "https://instagram.com.evil.example/reel/AbC-d_123/",
      "https://user:pass@www.instagram.com/reel/AbC-d_123/",
      "https://www.instagram.com:8443/reel/AbC-d_123/",
      "http://www.instagram.com/reel/AbC-d_123/",
      "not a url",
    ]) {
      expect(platformMetadataRoute(rawUrl)).toBeUndefined();
    }
  });

  it("AC7 leaks no identifier, body or provider text through a platform failure", async () => {
    const providerBody = JSON.stringify({ error: "quota exceeded for key sk-private-token" });
    const request = vi.fn<MetadataRequest>(async () => response(providerBody, "application/json", 403));
    const error = await rejection(fetchPlatformAwareMetadata(CANONICAL_VIDEO, {
      resolveHostname: publicResolver,
      request,
    }));

    const observable = JSON.stringify({ code: error.code, message: error.message });
    expect(METADATA_ERROR_CODES).toContain(error.code);
    for (const secret of [VIDEO_ID, "youtube", "instagram", "quota", "sk-private-token", "403"]) {
      expect(observable).not.toContain(secret);
    }
  });
});
