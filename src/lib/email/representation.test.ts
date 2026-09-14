import { describe, expect, it } from "vitest";

import {
  EXCERPT_TEXT_LIMIT,
  REPRESENTATION_VERSION,
  buildStoredRepresentation,
  parseStoredRepresentation,
  representationExcerpt,
  serializeRepresentation,
} from "./representation";

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";

const response = {
  id: EMAIL_ID,
  subject: "Worth reading",
  from: "newsletter@example.com",
  to: ["capture@later.resend.app"],
  cc: ["assistant@example.com"],
  bcc: ["hidden@example.com"],
  reply_to: ["replies@example.com"],
  received_for: ["forwarded@example.com"],
  message_id: "<111@mail.example.com>",
  created_at: "2026-09-08T10:00:00.000Z",
  text: "Read https://example.com/one",
  html: '<p><a href="https://example.com/two">two</a></p>',
  html_format: "cid",
  headers: { "list-id": "<news.example.com>", "x-object": { nested: true } },
  raw: { download_url: "https://inbound-cdn.resend.com/raw?signature=sig", expires_at: "later" },
  attachments: [
    {
      id: "att-1",
      filename: "brief.pdf",
      content_type: "application/pdf",
      size: 10,
      download_url: "https://inbound-cdn.resend.com/att-1?signature=sig",
    },
  ],
};

describe("stored email representation", () => {
  it("AC5 keeps the parsed email and drops every temporary provider URL", () => {
    const stored = buildStoredRepresentation(EMAIL_ID, response, "2026-09-08T10:00:30.000Z");

    expect(stored.version).toBe(REPRESENTATION_VERSION);
    expect(stored.emailId).toBe(EMAIL_ID);
    expect(stored.text).toBe(response.text);
    expect(stored.html).toBe(response.html);
    expect(stored.htmlFormat).toBe("cid");
    expect(stored.bcc).toEqual(["hidden@example.com"]);
    expect(stored.replyTo).toEqual(["replies@example.com"]);
    expect(stored.receivedFor).toEqual(["forwarded@example.com"]);
    expect(stored.attachments).toEqual([
      { id: "att-1", filename: "brief.pdf", contentType: "application/pdf", contentDisposition: null, contentId: null, size: 10 },
    ]);
    // Non-scalar header values are dropped rather than half-copied.
    expect(stored.headers).toEqual({ "list-id": "<news.example.com>" });
    expect(JSON.stringify(stored)).not.toMatch(/download_url|downloadUrl|signature=|"raw"/u);
  });

  it("AC5 records every URL of the message in encounter order across subject, text and html", () => {
    const stored = buildStoredRepresentation(
      EMAIL_ID,
      { ...response, subject: "See https://example.com/zero" },
      "2026-09-08T10:00:30.000Z",
    );

    expect(stored.urls).toEqual([
      "https://example.com/zero",
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  it("round-trips through the bytes actually stored", () => {
    const stored = buildStoredRepresentation(EMAIL_ID, response, "2026-09-08T10:00:30.000Z");
    expect(parseStoredRepresentation(serializeRepresentation(stored))).toEqual(stored);
  });

  it.each([
    ["unparseable bytes", Buffer.from("{ not json", "utf8")],
    ["a JSON array", Buffer.from("[]", "utf8")],
    ["an unknown version", Buffer.from(JSON.stringify({ version: "other" }), "utf8")],
  ])("refuses to read back %s", (_name, bytes) => {
    expect(parseStoredRepresentation(bytes)).toBeUndefined();
  });

  it("AC7 excludes personal envelope fields from what a model may see", () => {
    const excerpt = representationExcerpt(
      buildStoredRepresentation(EMAIL_ID, response, "2026-09-08T10:00:30.000Z"),
    );

    expect(excerpt.subject).toBe("Worth reading");
    expect(excerpt.text).toBe(response.text);
    expect(excerpt.htmlPresent).toBe(true);
    expect(excerpt.headerKeys).toEqual(["list-id"]);
    expect(excerpt.attachmentCount).toBe(1);
    expect(JSON.stringify(excerpt)).not.toMatch(
      /newsletter@|capture@|assistant@|hidden@|replies@|forwarded@|list-id: |news\.example/u,
    );
    expect(Object.keys(excerpt)).not.toContain("from");
    expect(Object.keys(excerpt)).not.toContain("to");
  });

  it("AC7 bounds the body it hands a model and says so", () => {
    const long = "x".repeat(EXCERPT_TEXT_LIMIT + 10);
    const excerpt = representationExcerpt(
      buildStoredRepresentation(EMAIL_ID, { ...response, text: long }, "2026-09-08T10:00:30.000Z"),
    );

    expect(excerpt.text).toHaveLength(EXCERPT_TEXT_LIMIT);
    expect(excerpt.textTruncated).toBe(true);
  });

  it("reports an email with no body honestly rather than as an empty one", () => {
    const excerpt = representationExcerpt(
      buildStoredRepresentation(EMAIL_ID, { ...response, text: null, html: null }, "2026-09-08T10:00:30.000Z"),
    );

    expect(excerpt.text).toBeNull();
    expect(excerpt.textTruncated).toBe(false);
    expect(excerpt.htmlPresent).toBe(false);
  });
});
