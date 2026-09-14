# Inbound email capture

`POST /api/inbound/email` accepts Resend `email.received` events. Resend delivers metadata
only — the body, headers and attachment bytes are retrieved separately — so the webhook
persists what it was given and queues the rest.

## The webhook

The raw request body is verified before it is parsed, using the Standard Webhooks scheme
Resend signs with (`svix-id`, `svix-timestamp`, `svix-signature`; the `webhook-*` spellings
are accepted too). Verification uses `standardwebhooks`, the library Resend's own
`webhooks.verify` delegates to. It is used directly rather than through the `resend` SDK
because that SDK's constructor requires an API key, and the public webhook path must not
hold one. A missing, invalid or out-of-window signature returns 403 and nothing else runs:
no parsing, no persistence, no provider request, no model call.

Mail is captured only when some recipient's local part — from `To`, `Cc`, `Bcc` or the
forwarding `for` clause, lowercased, with any `+tag` removed — equals `EMAIL_INBOUND_TOKEN`,
compared on bytes. It is attributed to `EMAIL_CAPTURE_USER_ID`. Sender and recipient fields
are captured provider data and never an identity: a message that names a different token gets
the same fixed `Accepted` body as one that is captured, so a sender cannot probe for the
address or the user behind it.

One message is one capture, keyed for idempotency on the Resend email id, so a replayed
delivery under a new `svix-id` yields exactly one capture, one initial intent job and one
enrichment job. `raw_payload` retains the signed event verbatim alongside the email id,
message id, subject, sender, every recipient list, attachment metadata and every URL in the
subject in encounter order. The capture kind is `email`, stated rather than derived. The
route returns after the capture and its enrichment job commit and calls neither Resend nor
Anthropic.

## Enrichment

`email_enrichment` is a queue alongside `intent_analysis` and `media_download`; the job
endpoint rotates all three so none starves the others, and an unconfigured email channel
reads as an empty queue rather than breaking the others.

Capture time creates the asset rows: one for the parsed representation (`email.json`) and one
per announced attachment, each `pending` in the private `capture-assets` bucket. The job fills
them, reusing the later-0007 asset lifecycle unchanged — same bucket, same read-before-write
reconciliation after a crash, same evidence columns.

The representation is stored first, so provenance exists even if an attachment then fails. It
is an allow-list of `GET /emails/receiving/{id}`: text, HTML, headers, addresses, attachment
metadata and every URL across subject, text and HTML in encounter order. The response's
`raw.download_url` and each attachment's `download_url` are deliberately **not** copied — they
are short-lived signed credentials, and storing one would turn an expiring credential into
durable content. Only the bytes themselves are kept.

Attachments come from `GET /emails/receiving/{id}/attachments`. Downloads are HTTPS-only to a
`resend.com` host with no port or embedded credentials, never carry the API key, follow at most
three manually re-checked redirects, enforce declared and streamed size against `EMAIL_MAX_BYTES`,
and go through the same content validation as WhatsApp media — active HTML/SVG/JavaScript and
executables are refused. An attachment Resend does not list is `attachment_missing`; an asset
row that never existed for a listed attachment is left alone.

Failures split two ways. A code that describes the input — unsafe origin or redirect, a
MIME/size mismatch, unsafe or missing content — is terminal for the thing it describes: that one
asset fails, visibly, and the rest of the email still lands. Anything else becomes
`email_unavailable` and aborts the attempt so the queue's retry policy owns it: three attempts,
one/two-minute backoff, ten-minute lease. Provider text never reaches `last_error` or
`storage_error`. An exhausted job fails and every still-pending asset of that capture is marked
failed with the job's code, so nothing can read as "still coming" forever. The capture and any
successful earlier analysis are never rewritten.

## The enriched run

Once every asset is terminal and the initial intent attempt has finished, one enriched
`intent_analysis` job is scheduled — the same capture lock and unique index as the media path,
so it can neither race the initial run nor duplicate. Its snapshot carries the stored email
under `email` with the provenance that identifies it: asset id, SHA-256, byte size, storage
state. The body is bounded at 32 KiB with an explicit `textTruncated` flag; a representation
over 5 MiB, still pending, failed, unparseable, or whose bytes no longer match the recorded
digest is reported metadata-only with the reason rather than presented as complete.

Sender and recipient addresses are excluded from model input. Header *names* are included —
"this was a list mailing" is evidence — but header *values* are not, because that is where the
addresses live. The run appends a new analysis row under its own prompt and pipeline versions;
the metadata-only run stays exactly as it was.

## Configuration

`RESEND_WEBHOOK_SECRET`, `EMAIL_INBOUND_TOKEN` and `EMAIL_CAPTURE_USER_ID` serve the webhook;
`RESEND_API_KEY`, optional `RESEND_API_BASE_URL` and `EMAIL_MAX_BYTES` (default 5 MiB, allowed
1 byte through 20 MiB) serve the background job. Deploy the migration before the new worker code.

## Validation

Run the configured `pnpm build`, `pnpm lint`, `pnpm test` and `pnpm test:coverage`. The unit
tests need no network and no database. Run the SQL tests on an isolated Supabase stack with
`supabase test db --workdir <isolated-project> --db-url <local-admin-connection>`, as described
in `../assets/README.md`. Never run them against a live database.

Protocol references: [Receiving emails](https://resend.com/docs/dashboard/receiving/introduction),
[email.received](https://resend.com/docs/webhooks/emails/received),
[Retrieve received email](https://resend.com/docs/api-reference/emails/retrieve-received-email),
[List attachments](https://resend.com/docs/api-reference/emails/list-received-email-attachments),
[Verify webhook requests](https://resend.com/docs/webhooks/verify-webhooks-requests).
