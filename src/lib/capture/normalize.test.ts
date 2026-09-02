import { describe, expect, it, vi } from "vitest";

import { normalizeCaptureInput, type ProviderNeutralCaptureInput } from "./normalize";

describe("normalizeCaptureInput", () => {
  it("AC1 returns one lossless capture with every URL in encounter order", () => {
    const rawProviderPayload = { message: { untouched: true }, sequence: 7 };
    const rawText =
      "Background first: https://example.com/one then details at https://example.org/two?q=2";

    const capture = normalizeCaptureInput({ rawText, rawProviderPayload });

    expect(capture).not.toBeInstanceOf(Array);
    expect(capture.urls).toEqual([
      "https://example.com/one",
      "https://example.org/two?q=2",
    ]);
    expect(capture.rawText).toBe(rawText);
    expect(capture.rawProviderPayload).toBe(rawProviderPayload);
  });

  it.each([
    ["https://instagram.com/p/abc", "instagram"],
    ["https://www.instagram.com/reel/abc", "instagram"],
    ["https://youtu.be/abc", "youtube"],
    ["https://youtube.com/watch?v=abc", "youtube"],
    ["https://open.spotify.com/track/abc", "spotify"],
  ] as const)("AC2 classifies recognized URL %s as %s", (rawText, sourcePlatform) => {
    expect(normalizeCaptureInput({ rawText }).sourcePlatform).toBe(sourcePlatform);
  });

  it("AC2 leaves source platform unknown for unrecognized and mixed-platform URLs", () => {
    expect(normalizeCaptureInput({ rawText: "https://example.com/item" })).not.toHaveProperty(
      "sourcePlatform",
    );
    expect(
      normalizeCaptureInput({
        rawText: "https://instagram.com/p/abc https://youtu.be/xyz",
      }),
    ).not.toHaveProperty("sourcePlatform");
  });

  it("AC3 retains capture context as separate, exact values", () => {
    const attachments = [
      {
        id: "media-1",
        contentType: "image/jpeg",
        fileName: "photo.jpg",
        sizeBytes: 1234,
        providerSpecificPosition: 2,
      },
    ] as const;
    const input: ProviderNeutralCaptureInput = {
      userNote: "Use this for the trip",
      externalMessageId: "message-42",
      channel: "whatsapp",
      capturedAt: "2026-09-02T14:33:54.123Z",
      attachments,
    };

    const capture = normalizeCaptureInput(input);

    expect(capture.userNote).toBe(input.userNote);
    expect(capture.externalMessageId).toBe(input.externalMessageId);
    expect(capture.channel).toBe(input.channel);
    expect(capture.capturedAt).toBe(input.capturedAt);
    expect(capture.attachments).toBe(attachments);
  });

  it.each([
    [{ rawText: "Remember this explanation" }, "text"],
    [{ rawText: "https://example.com/item" }, "link"],
    [{ attachments: [{ id: "media-1" }] }, "attachment"],
    [{ rawText: "A note https://example.com/item" }, "mixed"],
    [{}, "unknown"],
  ] as const)("AC4 derives conservative kind %s", (input, expectedKind) => {
    expect(normalizeCaptureInput(input).kind).toBe(expectedKind);
  });

  it("AC5 is deterministic and does not access I/O or the clock", () => {
    const input = {
      rawText: "Keep https://open.spotify.com/track/abc",
      capturedAt: "2026-09-02T14:33:54Z",
      rawProviderPayload: { provider: "fixture" },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clockSpy = vi.spyOn(Date, "now");

    const first = normalizeCaptureInput(input);
    const second = normalizeCaptureInput(input);

    expect(second).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clockSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    clockSpy.mockRestore();
  });
});
