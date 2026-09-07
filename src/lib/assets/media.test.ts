import { describe, expect, it, vi } from "vitest";
import { configuredMedia, DEFAULT_MEDIA_MAX_BYTES, digest, downloadTwilioMedia, validateMedia } from "./media";
import { processNextMediaJob } from "./process";
import type { MediaStore } from "./store";

const config = { accountSid: `AC${"a".repeat(32)}`, authToken: "TEST-ONLY-SECRET", maxBytes: 1024 };
const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages/SM${"b".repeat(32)}/Media/ME${"c".repeat(32)}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
const response = () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });

function mediaStore(): MediaStore & { finish: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  return {
    claim: async () => ({ id: "job", captureId: "capture", assetId: "asset", jobType: "media_download", attempts: 1 }),
    load: async () => ({ id: "asset", captureId: "capture", storagePath: "captures/user/capture/1-asset", providerUrl: url, mediaType: "image/png" }),
    read: async () => undefined,
    put: vi.fn(async () => {}), finish: vi.fn(async () => true),
  };
}
describe("private WhatsApp media", () => {
  it("AC2 stores the exact binary at the precomputed path with observed evidence", async () => {
    const store = mediaStore(); const fetcher = vi.fn<typeof fetch>(async () => response());
    expect(await processNextMediaJob(store, config, fetcher)).toMatchObject({ status: "succeeded" });
    expect(store.put).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storagePath: "captures/user/capture/1-asset" }), {
      bytes: png, byteSize: png.length, mediaType: "image/png", sha256: digest(png),
    });
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 }), { byteSize: png.length, mediaType: "image/png", sha256: digest(png) });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}` } });
  });
  it.each(["https://attacker.invalid/file", "http://api.twilio.com/file", "https://api.twilio.com.attacker.invalid/file", "https://user:pass@mms.twiliocdn.com/file", "https://mms.twiliocdn.com:444/file", "https://127.0.0.1/file"])(
    "AC3 rejects an unapproved origin without a request: %s", async (destination) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(downloadTwilioMedia(destination, "image/png", config, fetcher)).rejects.toMatchObject({ code: "unsafe_origin" });
      expect(fetcher).not.toHaveBeenCalled();
    });
  it("AC3 rejects a hostile redirect before forwarding credentials or committing an object", async () => {
    const store = mediaStore();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/stolen" } }));
    expect(await processNextMediaJob(store, config, fetcher)).toMatchObject({ status: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(store.put).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), null, "unsafe_redirect");
  });
  it("AC3 follows only approved CDN redirects and strips account credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://mms.twiliocdn.com/signed-media?signature=test" } })).mockResolvedValueOnce(response());
    expect((await downloadTwilioMedia(url, "image/png", config, fetcher)).bytes).toEqual(png);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ "accept-encoding": "identity" });
  });
  it.each([
    ["declared oversize", () => new Response(png, { headers: { "content-type": "image/png", "content-length": "1025" } }), "media_too_large"],
    ["streamed oversize", () => new Response(new Uint8Array(1025), { headers: { "content-type": "image/png" } }), "media_too_large"],
    ["declared MIME mismatch", () => new Response(png, { headers: { "content-type": "image/jpeg" } }), "media_mismatch"],
    ["observed MIME mismatch", () => new Response("not an image", { headers: { "content-type": "image/png" } }), "media_mismatch"],
    ["incorrect length", () => new Response(png, { headers: { "content-type": "image/png", "content-length": "1" } }), "media_mismatch"],
    ["encoded body", () => new Response(png, { headers: { "content-type": "image/png", "content-encoding": "gzip" } }), "media_mismatch"],
    ["expired media", () => new Response(null, { status: 404 }), "media_missing"],
    ["outage", () => new Response(null, { status: 503 }), "media_unavailable"],
  ] as const)("AC3 does not commit %s and records only a safe failure code", async (_name, makeResponse, code) => {
    const store = mediaStore();
    await processNextMediaJob(store, config, async () => makeResponse());
    expect(store.put).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), null, code);
  });
  it("accepts documented MM message identifiers as well as SM", async () => {
    expect((await downloadTwilioMedia(url.replace("/SM", "/MM"), "image/png", config, async () => response())).bytes).toEqual(png);
  });
  it("AC3 bounds redirect loops and suppresses transport error text", async () => {
    const looping = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: url } }));
    await expect(downloadTwilioMedia(url, "image/png", config, looping)).rejects.toMatchObject({ code: "unsafe_redirect" });
    expect(looping).toHaveBeenCalledTimes(4);
    const store = mediaStore();
    await processNextMediaJob(store, config, async () => { throw new Error(config.authToken); });
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), null, "media_unavailable");
  });
  it("AC4 reconciles a committed upload after a crash without downloading or storing twice", async () => {
    const store = mediaStore(); store.read = async () => ({ bytes: png, mediaType: "image/png" });
    const fetcher = vi.fn<typeof fetch>();
    await processNextMediaJob(store, config, fetcher);
    await processNextMediaJob(store, config, fetcher);
    expect(store.put).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(expect.anything(), { sha256: digest(png), byteSize: png.length, mediaType: "image/png" });
  });
  it("does not report a success when the database rejects an expired lease", async () => {
    const store = mediaStore(); store.finish.mockResolvedValue(false);
    expect(await processNextMediaJob(store, config, async () => response())).toMatchObject({ status: "failed" });
  });
  it("AC6 retains unsupported audio, video and document binaries without transformation", () => {
    for (const [type, bytes] of [["audio/amr", Buffer.from("#!AMR\nexample")], ["video/mp4", Buffer.from("0000ftypisom")], ["application/pdf", Buffer.from("%PDF-1.7\nexample")]] as const) {
      expect(validateMedia(bytes, type, type, config.maxBytes)).toMatchObject({ bytes, mediaType: type, byteSize: bytes.length });
    }
    expect(() => validateMedia(Buffer.from("<html>unsafe"), "text/html", "text/html", 1024)).toThrow("unsafe_media");
  });
  it("has a conservative configured ceiling and rejects invalid configuration", () => {
    const env = { TWILIO_ACCOUNT_SID: config.accountSid, TWILIO_AUTH_TOKEN: config.authToken };
    expect(configuredMedia(env).maxBytes).toBe(DEFAULT_MEDIA_MAX_BYTES);
    for (const value of ["0", "-1", "no", "1.5", "999999999"]) expect(() => configuredMedia({ ...env, CAPTURE_MEDIA_MAX_BYTES: value })).toThrow();
    expect(() => configuredMedia({})).toThrow();
  });
});
