---
id: "later-0004"
title: "Accept authenticated WhatsApp captures immediately"
status: "in_progress"
priority: 3
project: "later"
owner: "codex-later-0004-01a064fe"
created: "2026-09-02"
started: "2026-09-03T02:01:19Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "package.json", "pnpm-lock.yaml", "src/app/api/inbound/whatsapp/**", "src/lib/twilio/**"]
labels: ["capture", "whatsapp", "security"]
notes: ["Depends on later-0003 for the normalized capture persistence operation and idempotency boundary."]
---

## Context

WhatsApp through Twilio is Later v0's primary capture interface. A valid message must be persisted and queued before the user receives the fixed acknowledgement `Saved for Later ✓`, while signature failures must never reach storage. Intelligence, URL fetching and media downloading remain outside the acknowledgement path.

## Scope

- Add `POST /api/inbound/whatsapp` as a Twilio-compatible form webhook.
- Validate every request with Twilio's official signature algorithm, using an explicitly configured public webhook URL so proxy/internal host differences cannot weaken or accidentally break validation.
- Parse Twilio message fields into the provider-neutral capture input from later-0001, including `MessageSid`, body, sender metadata and all declared media metadata.
- Call the atomic persistence operation from later-0003 and return TwiML containing exactly `Saved for Later ✓` after persistence and initial job creation succeed.
- Treat Twilio retries with the same `MessageSid` idempotently and return the same successful acknowledgement.
- Document only the required server-side Twilio variables in `.env.example`.
- Do not download media, invoke AI, fetch submitted URLs, resolve sources, reveal inferred intent or add any non-WhatsApp interface.

## Acceptance criteria

- [ ] Given a missing or invalid Twilio signature, when the webhook is called, then it returns a non-success response and no normalization or persistence operation runs.
- [ ] Given a valid signed text or URL message, when persistence and initial job creation succeed, then the webhook returns successful TwiML containing exactly `Saved for Later ✓` and the normalized capture retains the Twilio payload and `MessageSid`.
- [ ] Given a valid message declaring multiple media items, when it is accepted, then all available media URLs, MIME types and provider indexes are passed as metadata without downloading the binaries during the request.
- [ ] Given the same valid `MessageSid` is delivered more than once, when the webhook handles the retries, then only one capture and one initial intent job exist while every successful delivery receives the fixed acknowledgement.
- [ ] Given a valid message, when the acknowledgement path is exercised, then no AI client, source resolver, submitted-URL fetch or media download is invoked before the response completes.
- [ ] Given an explicitly configured public webhook URL, when signature validation runs behind a different internal host, then validation uses the configured public URL and does not trust forwarded host headers to choose the signed target.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The webhook's public URL is configuration, not inferred trust. The acknowledgement may fail if durable persistence itself fails; the requirement is that AI, resolution and media work can never cause capture failure or delay acknowledgement.
