import { describe, expect, it, vi } from "vitest";

import { MetadataError, type MetadataRequest, type MetadataResponse } from "./metadata";
import { fetchSegmentMaterial } from "./segment-material";

const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);

function response(body: string, contentType: string, status = 200, headers: Record<string, string> = {}): MetadataResponse {
  return { status, headers: { "content-type": contentType, ...headers }, body: new TextEncoder().encode(body) };
}

describe("segment source material retrieval", () => {
  it("AC1 parses a bounded WebVTT transcript into timed evidence with a stable identity and digest", async () => {
    const request = vi.fn<MetadataRequest>(async () => response(
      "WEBVTT\n\n00:00:10.000 --> 00:00:15.000\nOpening\n\n00:00:15.000 --> 00:00:22.000\nRelevant captured interest",
      "text/vtt; charset=utf-8",
    ));
    const material = await fetchSegmentMaterial("https://example.com/transcript.vtt", 120, {
      resolveHostname: publicResolver,
      request,
    });
    expect(material).toMatchObject({
      finalUrl: "https://example.com/transcript.vtt",
      contentType: "text/vtt",
      representation: "timed",
      durationSeconds: 120,
    });
    expect(material.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cue.0", startSeconds: 10, endSeconds: 15, text: "Opening" }),
    ]));
    expect(material.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["plain text", "text/plain", "Introduction\nRelevant captured interest", "text"],
    ["JSON text", "application/json", JSON.stringify({ text: "Relevant captured interest" }), "text"],
    ["JSON cues", "application/json", JSON.stringify({ segments: [
      { start: 3, end: 8, text: "Relevant captured interest" },
    ] }), "timed"],
  ])("AC2 accepts documented %s representations", async (_label, contentType, body, representation) => {
    const material = await fetchSegmentMaterial("https://example.com/material", null, {
      resolveHostname: publicResolver,
      request: async () => response(body, contentType),
    });
    expect(material.representation).toBe(representation);
    expect(material.content).toContain("Relevant captured interest");
  });

  it("AC5 rejects a prohibited destination before connection", async () => {
    const request = vi.fn<MetadataRequest>();
    await expect(fetchSegmentMaterial("https://127.0.0.1/transcript", 120, {
      resolveHostname: publicResolver,
      request,
    })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(request).not.toHaveBeenCalled();
  });

  it("AC5 revalidates redirects and rejects an internal target before fetching it", async () => {
    const request = vi.fn<MetadataRequest>(async () => response("", "text/plain", 302, {
      location: "https://internal.example/transcript",
    }));
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === "internal.example" ? "169.254.169.254" : "93.184.216.34",
      family: 4 as const,
    }]);
    await expect(fetchSegmentMaterial("https://example.com/transcript", null, {
      resolveHostname: resolver,
      request,
    })).rejects.toMatchObject({ code: "unsafe_redirect" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("AC5 rejects oversized and unsupported content before it can become model material", async () => {
    await expect(fetchSegmentMaterial("https://example.com/large", null, {
      resolveHostname: publicResolver,
      request: async () => response("x".repeat(33), "text/plain"),
      maximumBytes: 32,
    })).rejects.toMatchObject({ code: "metadata_too_large" });
    await expect(fetchSegmentMaterial("https://example.com/binary", null, {
      resolveHostname: publicResolver,
      request: async () => response("private", "application/octet-stream"),
    })).rejects.toBeInstanceOf(MetadataError);
  });
});
