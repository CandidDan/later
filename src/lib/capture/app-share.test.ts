import { describe, expect, it, vi } from "vitest";
import { appShareRawText, handleAppCapture, parseAppShareBody, type AppShareDependencies } from "./app-share";

const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const session = { userId: "11111111-1111-4111-8111-111111111111", accessToken: "token" };

function request(body: string): Request {
  return new Request("https://test.invalid/api/app/captures", { method: "POST", body });
}

describe("parseAppShareBody", () => {
  it("accepts exactly the app's shape", () => {
    const body = { requestId: REQUEST_ID, url: "http://example.test/", text: "t", note: "n", sharedAt: "2026-10-26T08:00:00.123+01:00" };
    expect(parseAppShareBody(body)).toEqual(body);
  });

  it.each([
    { requestId: REQUEST_ID, url: "https://example.test/a b" },
    { requestId: REQUEST_ID, url: "ftp://example.test/file" },
    { requestId: REQUEST_ID, url: "https://example.test/", note: null },
    { requestId: REQUEST_ID, text: "t", sharedAt: "2026-13-45T99:99:00Z" },
    { requestId: REQUEST_ID, text: "t", sharedAt: "2026-10-26" },
    "a string",
  ])("rejects %j", (body) => {
    expect(parseAppShareBody(body)).toBeUndefined();
  });
});

describe("appShareRawText", () => {
  it("joins the url and text with a newline, skipping what is absent", () => {
    expect(appShareRawText({ url: "https://example.test/", text: "why" })).toBe("https://example.test/\nwhy");
    expect(appShareRawText({ url: "https://example.test/", text: "" })).toBe("https://example.test/");
    expect(appShareRawText({ text: "only" })).toBe("only");
  });
});

describe("handleAppCapture", () => {
  it("sets the owner from the session and uses the injected clock for captured_at", async () => {
    const persist = vi.fn<AppShareDependencies["persist"]>(async () => ({ captureId: "c", intentJobId: "j", created: true }));
    const response = await handleAppCapture(request(JSON.stringify({ requestId: REQUEST_ID, text: "keep" })), {
      authenticate: async () => session,
      persist,
      now: () => new Date("2026-10-26T09:00:00Z"),
    });

    expect(response.status).toBe(201);
    expect(persist).toHaveBeenCalledWith({
      userId: session.userId,
      capture: expect.objectContaining({
        channel: "ios_share",
        kind: "text",
        externalMessageId: REQUEST_ID,
        capturedAt: "2026-10-26T09:00:00.000Z",
        attachments: [],
      }),
    });
  });

  it("is 503 when authentication itself fails", async () => {
    const response = await handleAppCapture(request("{}"), {
      authenticate: async () => { throw new Error("auth down"); },
      persist: vi.fn(),
    });

    expect(response.status).toBe(503);
  });

  it("rejects a declared content-length over the cap without reading the body", async () => {
    const persist = vi.fn();
    const oversize = new Request("https://test.invalid/", { method: "POST", body: JSON.stringify({ requestId: REQUEST_ID, text: "keep" }), headers: { "content-length": String(64 * 1024 + 1) } });
    const response = await handleAppCapture(oversize, { authenticate: async () => session, persist });

    expect(response.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });
});
