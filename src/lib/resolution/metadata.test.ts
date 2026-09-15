import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_METADATA_MAX_BYTES,
  DEFAULT_METADATA_TIMEOUT_MS,
  fetchPublicMetadata,
  MetadataError,
  type MetadataRequest,
  type MetadataResponse,
} from "./metadata";

const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

function response(
  body: string,
  contentType = "text/html; charset=utf-8",
  status = 200,
  extraHeaders: Record<string, string> = {},
): MetadataResponse {
  return {
    status,
    headers: { "content-type": contentType, ...extraHeaders },
    body: new TextEncoder().encode(body),
  };
}

describe("public metadata retrieval", () => {
  it.each([
    "http://example.com/page",
    "https://user:pass@example.com/page",
    "https://localhost/page",
    "https://127.0.0.1/page",
    "https://[::1]/page",
  ])("AC4 rejects non-public destination %s before connection", async (url) => {
    const request = vi.fn<MetadataRequest>();
    await expect(fetchPublicMetadata(url, { resolveHostname: publicResolver, request }))
      .rejects.toBeInstanceOf(MetadataError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["10.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.2", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"])(
    "AC4 rejects DNS resolution to private or link-local address %s",
    async (address) => {
      const request = vi.fn<MetadataRequest>();
      await expect(fetchPublicMetadata("https://example.com/page", {
        resolveHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        request,
      })).rejects.toMatchObject({ code: "unsafe_url" });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("AC4 re-resolves a redirect and rejects its private target before a second connection", async () => {
    const request = vi.fn<MetadataRequest>(async () => response("", "text/html", 302, {
      location: "https://internal.example/metadata",
    }));
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === "internal.example" ? "169.254.169.254" : "93.184.216.34",
      family: 4 as const,
    }]);

    await expect(fetchPublicMetadata("https://example.com/start", { resolveHostname: resolver, request }))
      .rejects.toMatchObject({ code: "unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unsupported content", response("secret", "application/octet-stream"), "metadata_unsupported"],
    ["oversized content", response("x".repeat(33)), "metadata_too_large"],
  ])("AC4 rejects %s before its content can become model input", async (_label, result, code) => {
    const request = vi.fn<MetadataRequest>(async () => result as MetadataResponse);
    await expect(fetchPublicMetadata("https://example.com/page", {
      resolveHostname: publicResolver,
      request,
      maximumBytes: 32,
    })).rejects.toMatchObject({ code });
  });

  it("AC1 returns only bounded supported metadata and validates discovered URLs", async () => {
    const request = vi.fn<MetadataRequest>(async () => response(`
      <meta property="og:title" content="The Source Episode">
      <meta name="author" content="Ada Example">
      <link rel="canonical" href="https://example.com/episodes/source">
      <link rel="transcript" type="text/vtt" href="https://example.com/source.vtt">
    `));
    const metadata = await fetchPublicMetadata("https://example.com/watch", {
      resolveHostname: publicResolver,
      request,
    });

    expect(metadata).toStrictEqual({
      requestedUrl: "https://example.com/watch",
      finalUrl: "https://example.com/watch",
      contentType: "text/html",
      title: "The Source Episode",
      creator: "Ada Example",
      canonicalUrl: "https://example.com/episodes/source",
      transcriptUrl: "https://example.com/source.vtt",
    });
    expect(request.mock.calls[0][1]).toStrictEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(request.mock.calls[0][2]).toBe(DEFAULT_METADATA_MAX_BYTES);
    expect(request.mock.calls[0][3]).toBe(DEFAULT_METADATA_TIMEOUT_MS);
  });
});
