import { describe, expect, it, vi } from "vitest";

import type { EmailRetrievalConfiguration } from "./config";
import {
  downloadAttachment,
  listReceivedEmailAttachments,
  retrieveReceivedEmail,
} from "./resend";

const config: EmailRetrievalConfiguration = {
  apiKey: "re_TEST-ONLY-NOT-A-CREDENTIAL",
  apiBaseUrl: "https://api.resend.com",
  maxBytes: 1024,
};

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const PDF = Buffer.from("%PDF-1.7\nbody", "utf8");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Resend retrieval", () => {
  it("AC5 asks the documented receiving endpoint with a bearer key", async () => {
    const fetcher = vi.fn(async () => json({ id: EMAIL_ID, subject: "hi" }));

    await retrieveReceivedEmail(EMAIL_ID, config, fetcher as unknown as typeof fetch);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.resend.com/emails/receiving/${EMAIL_ID}`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${config.apiKey}`);
    // A redirected API call would be an unauthenticated call somewhere else.
    expect(init.redirect).toBe("error");
  });

  it.each([
    [503, "email_unavailable"],
    [404, "email_missing"],
    [410, "email_missing"],
    [401, "email_forbidden"],
    [403, "email_forbidden"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetcher = vi.fn(async () => new Response("upstream text", { status }));

    await expect(
      retrieveReceivedEmail(EMAIL_ID, config, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code });
  });

  it("AC6 refuses a response body larger than the configured ceiling", async () => {
    const fetcher = vi.fn(async () => json({ text: "x".repeat(2048) }));

    await expect(
      retrieveReceivedEmail(EMAIL_ID, config, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "email_too_large" });
  });

  it.each([
    ["a non-JSON body", new Response("<html>", { status: 200 })],
    ["a JSON array", json([])],
  ])("AC6 refuses %s", async (_name, response) => {
    const fetcher = vi.fn(async () => response);

    await expect(
      retrieveReceivedEmail(EMAIL_ID, config, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "email_response_invalid" });
  });

  it("AC5 lists attachments and keeps only entries it can actually fetch", async () => {
    const fetcher = vi.fn(async () =>
      json({
        object: "list",
        data: [
          { id: "att-1", filename: "a.pdf", content_type: "application/pdf", size: 4, download_url: "https://inbound-cdn.resend.com/a" },
          { id: "att-2", filename: "b.pdf" },
          { download_url: "https://inbound-cdn.resend.com/c" },
          "not an object",
        ],
      }),
    );

    const attachments = await listReceivedEmailAttachments(
      EMAIL_ID,
      config,
      fetcher as unknown as typeof fetch,
    );

    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
      `https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`,
    );
    expect(attachments).toEqual([
      {
        id: "att-1",
        filename: "a.pdf",
        contentType: "application/pdf",
        size: 4,
        downloadUrl: "https://inbound-cdn.resend.com/a",
      },
    ]);
  });

  it("AC6 refuses an attachment list that is not a list", async () => {
    const fetcher = vi.fn(async () => json({ object: "list" }));

    await expect(
      listReceivedEmailAttachments(EMAIL_ID, config, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "email_response_invalid" });
  });
});

describe("attachment download", () => {
  function binary(bytes: Buffer, headers: Record<string, string> = {}) {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "application/pdf", ...headers },
    });
  }

  it("AC5 never sends the API key to a signed CDN URL", async () => {
    const fetcher = vi.fn(async () => binary(PDF));

    const media = await downloadAttachment(
      "https://inbound-cdn.resend.com/att-1?signature=sig",
      "application/pdf",
      config.maxBytes,
      fetcher as unknown as typeof fetch,
    );

    expect(media.bytes.equals(PDF)).toBe(true);
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.stringify(init.headers)).not.toContain(config.apiKey);
    expect(init.redirect).toBe("manual");
  });

  it.each([
    ["a non-Resend host", "https://attacker.example/att-1"],
    ["a look-alike host", "https://resend.com.attacker.example/att-1"],
    ["plain HTTP", "http://inbound-cdn.resend.com/att-1"],
    ["embedded credentials", "https://user:pass@inbound-cdn.resend.com/att-1"],
    ["an explicit port", "https://inbound-cdn.resend.com:8443/att-1"],
    ["a value that is not a URL", "not-a-url"],
  ])("AC6 refuses %s", async (_name, url) => {
    const fetcher = vi.fn(async () => binary(PDF));

    await expect(
      downloadAttachment(url, null, config.maxBytes, fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "unsafe_origin" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AC6 follows a Resend redirect but re-checks its destination", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.resend.com/final" } }),
      )
      .mockResolvedValueOnce(binary(PDF));

    const media = await downloadAttachment(
      "https://inbound-cdn.resend.com/att-1",
      null,
      config.maxBytes,
      fetcher as unknown as typeof fetch,
    );

    expect(media.bytes.equals(PDF)).toBe(true);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://cdn.resend.com/final");
  });

  it.each([
    ["a redirect off Resend", "https://attacker.example/final"],
    ["a redirect with no destination", null],
  ])("AC6 refuses %s", async (_name, location) => {
    const fetcher = vi.fn(async () =>
      new Response(null, { status: 302, ...(location ? { headers: { location } } : {}) }),
    );

    await expect(
      downloadAttachment(
        "https://inbound-cdn.resend.com/att-1",
        null,
        config.maxBytes,
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "unsafe_redirect" });
  });

  it("AC6 refuses an endless redirect chain", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://inbound-cdn.resend.com/again" },
      }),
    );

    await expect(
      downloadAttachment(
        "https://inbound-cdn.resend.com/att-1",
        null,
        config.maxBytes,
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "unsafe_redirect" });
    // Three redirects followed, then a refusal — never an unbounded chase.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["a declared length over the ceiling", { "content-length": "99999" }, "email_too_large"],
    ["a compressed body it cannot size", { "content-encoding": "gzip" }, "media_mismatch"],
    ["a body shorter than declared", { "content-length": "9999" }, "email_too_large"],
  ])("AC6 refuses %s", async (_name, headers, code) => {
    const fetcher = vi.fn(async () => binary(PDF, headers));

    await expect(
      downloadAttachment(
        "https://inbound-cdn.resend.com/att-1",
        null,
        config.maxBytes,
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code });
  });

  it("AC6 refuses active content dressed as an attachment", async () => {
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array(Buffer.from("<html><script>x</script>", "utf8")), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      downloadAttachment(
        "https://inbound-cdn.resend.com/att-1",
        "text/html",
        config.maxBytes,
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "unsafe_media" });
  });
});
