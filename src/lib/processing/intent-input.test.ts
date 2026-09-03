import { describe, expect, it } from "vitest";

import { buildIntentInputSnapshot } from "./intent-input";
import type { CaptureRecord } from "../jobs/types";

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "capture-1",
    channel: "whatsapp",
    captureKind: "mixed",
    rawText: "look at this https://www.instagram.com/reel/abc/",
    userNote: "for Sunday lunch",
    sourcePlatform: "instagram",
    capturedAt: "2026-09-01T10:00:00.000Z",
    rawPayload: {
      NumMedia: "0",
      NumSegments: "1",
      MessageType: "text",
      From: "whatsapp:+15550001111",
      WaId: "15550001111",
      ProfileName: "Dana",
      MessageSid: "SM123",
    },
    assets: [{ filename: "clip.mp4", mediaType: "video/mp4", byteSize: 2048 }],
    ...overrides,
  };
}

describe("buildIntentInputSnapshot", () => {
  it("AC2 exposes only capture-time fields, with no retrospective or resolution data", () => {
    expect(Object.keys(buildIntentInputSnapshot(capture())).sort()).toStrictEqual([
      "assets",
      "captureId",
      "captureKind",
      "capturedAt",
      "channel",
      "messageMetadata",
      "rawText",
      "sourcePlatform",
      "urls",
      "userNote",
    ]);
  });

  it("AC2 carries the note, the deterministic platform and the extracted URLs verbatim", () => {
    const snapshot = buildIntentInputSnapshot(capture());

    expect(snapshot.userNote).toBe("for Sunday lunch");
    expect(snapshot.sourcePlatform).toBe("instagram");
    expect(snapshot.urls).toStrictEqual(["https://www.instagram.com/reel/abc/"]);
    expect(snapshot.assets).toStrictEqual([
      { filename: "clip.mp4", mediaType: "video/mp4", byteSize: 2048 },
    ]);
  });

  it("AC2 allow-lists message metadata, so identifiers never reach the model input", () => {
    const snapshot = buildIntentInputSnapshot(capture());

    expect(snapshot.messageMetadata).toStrictEqual({
      mediaCount: "0",
      segmentCount: "1",
      messageType: "text",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/15550001111|Dana|SM123/u);
  });

  it("AC2 keeps a note-free capture representable without inventing one", () => {
    const snapshot = buildIntentInputSnapshot(capture({ userNote: null, rawPayload: {} }));

    expect(snapshot.userNote).toBeNull();
    expect(snapshot.messageMetadata).toStrictEqual({});
  });
});
