---
id: "later-0008"
title: "Accept lossless inbound email captures"
status: "in_progress"
priority: 3
project: "later"
owner: "claude-code-later-0008"
created: "2026-09-06"
started: "2026-09-08T07:11:39Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "package.json", "pnpm-lock.yaml", "src/app/api/inbound/email/**", "src/app/api/jobs/process/**", "src/lib/assets/**", "src/lib/capture/**", "src/lib/email/**", "src/lib/jobs/**", "src/lib/processing/**", "supabase/migrations/*inbound_email_jobs.sql", "supabase/tests/database/*inbound_email_jobs.test.sql"]
labels: ["capture", "email", "resend", "security"]
notes: ["Worker session: implementation pushed on branch flow/later-0008-inbound-email (commit \"Accept lossless inbound email captures with background enrichment\"). Done: webhook route POST /api/inbound/email with Standard Webhooks (svix-*) verification via standardwebhooks, single-user local-part token match, lossless capture envelope, capture-time asset rows for the parsed representation plus each announced attachment, migration 20260908090000_inbound_email_jobs.sql adding the email_enrichment queue and extending enqueue_media_enrichment, background enrichment retrieving GET /emails/receiving/{id} and its /attachments with bounded downloads, and the enriched intent snapshot carrying an envelope-free email excerpt with assetId/sha256 provenance. Decision (do not re-litigate): verification uses standardwebhooks (the exact helper resend.webhooks.verify delegates to) rather than the resend SDK, because the SDK constructor demands an API key and the public webhook path must not hold one. Not yet done: vitest suites for src/lib/email/**, the supabase/tests/database/*inbound_email_jobs.test.sql SQL test, .env.example entries, README, and the four local gates. Next action: write those tests, run pnpm build/lint/test/test:coverage, then open PR titled \"[later-0008] Accept lossless inbound email captures\".", "Run after later-0007 so email enrichment can reuse the durable asset lifecycle. Resend is the selected v0 inbound provider: it signs email.received webhooks, retains the full parsed email for API retrieval, and exposes temporary attachment downloads. Official references: https://resend.com/docs/dashboard/receiving/introduction and https://resend.com/docs/webhooks/verify-webhooks-requests."]
---

## Context

Forwarded newsletters and recommendations are a core natural capture behavior in the approved v0 spec. Resend's webhook contains enough metadata to persist the inbound event immediately, while the complete parsed body, headers and attachment bytes are retrieved separately. Later must acknowledge Resend only after durable capture and enrichment work exist, but must not wait for Resend API calls or intent analysis.

## Scope

- Add `POST /api/inbound/email` for Resend `email.received` events and verify the raw request body using the Resend webhook signing secret before parsing or persisting it.
- Accept mail only when a recipient's local part matches the configured single-user inbound token, and attribute it to the configured capture user. Treat all sender and recipient fields as captured provider data, never as authorization or a database user id.
- Normalize one inbound message as one capture, retaining the signed event payload, Resend email id, message id, subject, sender, recipients, attachment metadata and every URL in encounter order. Extend the provider-neutral capture kind only as needed to represent email explicitly.
- Persist the capture idempotently by Resend email id and enqueue one background email-enrichment job before returning success. Do not call Resend or Anthropic in the webhook request.
- In the background, retrieve the full parsed text, HTML and headers plus every attachment from Resend; preserve the exact parsed representation and original attachment bytes in private capture storage using the asset lifecycle from later-0007.
- Append a new enriched intent run after the full email representation and attachments reach terminal states, while preserving any earlier metadata-only analysis.
- Apply bounded downloads and safe retries. Temporary Resend URLs, API keys, webhook secrets and unnecessary personal envelope fields must not enter model input or safe error text.
- Do not send an acknowledgement email, build mailbox UI, split one email into multiple captures, summarise the email, resolve its sources, or add another inbound provider.

## Acceptance criteria

- [ ] Given a missing, expired or invalid Resend signature, when the webhook is called, then it returns a non-success response and performs no normalization, persistence, provider fetch or model call.
- [ ] Given a valid `email.received` event addressed to the configured token, when capture and enrichment-job creation succeed, then the route returns success with one lossless capture and one enrichment job before any Resend content request begins.
- [ ] Given a valid signed event addressed only to a different local-part token, when it is received, then no capture is created and the response reveals no configured token or user identity.
- [ ] Given Resend retries or replays the same email id with a different webhook delivery id, when the events are handled, then exactly one capture, one initial intent job and one email-enrichment job exist.
- [ ] Given the Resend API returns text, HTML, headers and multiple attachments, when enrichment completes, then the parsed representation and exact attachment bytes are retained privately, every URL remains associated with the one original email capture, and provider download URLs are not stored as durable content.
- [ ] Given email retrieval or attachment download fails, when the retry policy is exhausted, then the initial capture and any successful initial intent run remain intact, safe failure state is visible on the job/assets, and no partial object is presented as complete.
- [ ] Given enrichment succeeds, when intent processing sees the complete email, then it appends a distinct analysis whose provenance identifies the stored email representation and assets without overwriting the capture or earlier analysis.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Resend stores inbound mail before webhook delivery and may deliver webhooks more than once. Use the email id for capture idempotency and verify the raw body with the SDK's signing helper. The task deliberately stores Resend's complete parsed representation rather than claiming access to raw RFC 822 bytes that the provider does not supply.
