---
id: "later-0007"
title: "Store WhatsApp media privately and enrich intent analysis"
status: "ready"
priority: 3
project: "later"
owner: ""
created: "2026-09-06"
started: "2026-09-07T05:58:58Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "src/app/api/jobs/process/**", "src/lib/assets/**", "src/lib/jobs/**", "src/lib/processing/**", "supabase/migrations/*capture_media_jobs.sql", "supabase/tests/database/*capture_media_jobs.test.sql"]
labels: ["capture", "whatsapp", "media", "security"]
notes: ["Run after later-0006. WhatsApp already preserves every media reference at capture time; this task retrieves binaries out of band. Store every original, but send only Anthropic-supported image media to the model. A later enriched analysis is appended and never replaces the initial metadata-only run."]
---

## Context

The WhatsApp webhook deliberately records only media metadata before acknowledging. That protects capture latency, but a screenshot or image currently leaves the intent model with a filename and MIME type rather than the content that caught the user's attention. The original binary must be retained privately, and richer context must create a new experimental run rather than rewriting the capture or its first analysis.

## Scope

- Extend the job schema and atomic capture persistence so each newly accepted WhatsApp asset has one durable media-download job identifying that asset, without changing the acknowledgement contract.
- Fetch Twilio media only in the background with server-side Twilio credentials. Restrict requests and redirects to approved Twilio media origins, apply a configured byte ceiling, and reject a response whose declared and observed media properties are unsafe or inconsistent.
- Store the exact downloaded bytes at the asset's existing user/capture-scoped path in the private `capture-assets` bucket; record a digest, byte size, terminal storage state and safe failure state without replacing the original provider metadata.
- Make download and storage idempotent across Twilio webhook retries and job retries.
- After every asset for a capture reaches a terminal stored or failed state, enqueue exactly one enriched `intent_analysis` job. Preserve the original analysis and append the enriched run.
- Include stored image content in the Anthropic request only for explicitly supported image MIME types. Keep raw bytes, temporary provider URLs and credentials out of `input_snapshot`; record stable asset identity, digest, MIME type and size as the evidence provenance.
- Preserve unsupported media types as original private assets and metadata without pretending their content was analysed.
- Do not fetch arbitrary submitted URLs, implement OCR/transcription, resolve an underlying source, expose intent to the user, or change the fixed WhatsApp acknowledgement.

## Acceptance criteria

- [ ] Given a valid signed WhatsApp message with two media items, when it is captured, then the response still contains exactly `Saved for Later ✓`, two asset records and two pending download jobs exist, and no media request occurs before the response completes.
- [ ] Given a valid Twilio media response within the byte ceiling, when its job runs, then the exact bytes are stored once at the precomputed private path and the asset records the observed MIME type, byte count, digest and stored timestamp.
- [ ] Given a non-Twilio origin, an unsafe redirect, an oversized body or a MIME mismatch, when download is attempted, then no object is committed, no credential is forwarded to that destination, and the job follows the safe retry/terminal-failure policy without losing the capture.
- [ ] Given the same webhook or media job is delivered more than once, when processing completes, then Later has one capture, one stored object per provider asset and no duplicate download or enrichment job.
- [ ] Given the initial intent run is already complete and every media job reaches a terminal state, when enrichment is scheduled, then exactly one new intent run is appended and the original run remains byte-for-byte unchanged.
- [ ] Given a supported stored image, when the enriched Anthropic request is built, then the image content is supplied to the model while the persisted input snapshot contains only stable private asset provenance; given unsupported audio, video or document media, only its metadata is analysed.
- [ ] Given two authenticated users or an unsigned storage request, when either tries to read the stored object, then existing ownership isolation and private-bucket behavior prevent cross-user or public access.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Use `TWILIO_ACCOUNT_SID` plus the existing auth token only on the server. The byte ceiling must be configuration with a conservative documented default. Download failure is processing failure, never capture failure.
