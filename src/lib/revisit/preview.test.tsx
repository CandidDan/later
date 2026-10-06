import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureCardView, startPrivatePreview } from "./capture-card";
import type { CaptureCard } from "./card";

const state = vi.hoisted(() => ({ preview: undefined as { key: string; url: string } | undefined }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(() => [state.preview, vi.fn()]), useEffect: vi.fn() };
});
afterEach(() => { vi.restoreAllMocks(); state.preview = undefined; });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const response = () => new Response(new Blob(["private raster"]));
describe("private preview lifecycle and rendered bytes", () => {
  it("AC3 renders only an authenticated temporary raster URL and revokes it on cleanup", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const ready = vi.fn((url: string) => { state.preview = { key: "capture/image/token", url }; });
    const failed = vi.fn();
    const cleanup = startPrivatePreview("capture", "image", "token", ready, failed, vi.fn(async () => response()));
    await settle();
    expect(create).toHaveBeenCalledOnce(); expect(await (create.mock.calls[0][0] as Blob).text()).toBe("private raster");
    const card: CaptureCard = { captureId: "capture", rawText: "", note: "", kind: "image", channel: "whatsapp", source: "", savedAt: "2026-09-25T00:00:00Z", inferred: [], assets: [{ id: "image", filename: "photo.png", mediaType: "image/png", available: true, raster: true }] };
    const render = (token: string) => renderToStaticMarkup(<CaptureCardView card={card} accessToken={token} now={new Date("2026-10-05T00:00:00Z")} timeZone="UTC" />);
    expect(render("token")).toContain('<img src="blob:private-preview" alt="Captured attachment: photo.png"');
    expect(render("different-session")).not.toContain("blob:private-preview");
    cleanup(); cleanup(); expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:private-preview"); expect(failed).not.toHaveBeenCalled();
  });
  it("AC4 discards late private responses after unmount or caller change without creating URLs", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const ready = vi.fn(), failed = vi.fn();
    const cleanup = startPrivatePreview("capture", "image", "old-token", ready, failed, fetcher);
    cleanup(); finish(response()); await settle();
    expect(create).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
  it("AC3 exposes neutral failure only for the active preview", async () => {
    const ready = vi.fn(), failed = vi.fn();
    startPrivatePreview("capture", "image", "token", ready, failed, async () => new Response(null, { status: 404 }));
    await settle(); expect(failed).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
    const inactiveFailure = vi.fn();
    const cleanup = startPrivatePreview("capture", "image", "token", ready, inactiveFailure, async () => { throw Error("private details"); });
    cleanup(); await settle(); expect(inactiveFailure).not.toHaveBeenCalled();
  });
});
