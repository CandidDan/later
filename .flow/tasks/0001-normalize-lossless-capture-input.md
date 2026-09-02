---
id: "later-0001"
title: "Normalize inbound content without losing capture context"
status: "in_review"
priority: 3
project: "later"
owner: "codex-later-0001-01a05aa4"
created: "2026-09-02"
started: "2026-09-02T14:33:54Z"
branch: "flow/later-0001-normalize-inbound-content"
pr: "https://github.com/CandidDan/later/pull/3"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: ["src/lib/capture/**"]
labels: ["capture", "domain"]
notes: ["Worker handoff 2026-09-02: Implemented the provider-neutral capture types and pure deterministic normalization on flow/later-0001-normalize-inbound-content; PR https://github.com/CandidDan/later/pull/3 is open. AC1-AC5 are proved by the named tests in src/lib/capture/normalize.test.ts. Local build (webpack backend because sandboxed Turbopack could not bind its helper port), lint, test, and coverage passed; coverage was 88.09% lines against the 15% floor. Hosted Flow gate, touches, QA, code-review, security, status, tooling, and auto-opener checks are green. Decision: preserve supplied payload and attachment references exactly, classify only a sole recognized platform, and use text/link/attachment/mixed/unknown conservative kinds. Genuinely done: implementation, tests, PR, and all checks. Not done: human validation and merge. Next action: review PR #3 and merge it if accepted; flow-done will then mark the task done."]
---

## Context

Later must preserve what the user actually sent before any intelligence is applied. The approved Capture & Intent v0 spec treats a capture as the whole inbound act, not one record per URL, and requires deterministic preprocessing to retain all naturally available capture-time context. This task establishes that provider-neutral boundary without involving a database, webhook, media download or model.

## Scope

- Define the typed provider-neutral input and normalized capture shapes used by later channel adapters.
- Normalize capture channel, kind, raw text, explicit user note, external message id, capture time, raw provider payload and attachment metadata without discarding supplied values.
- Extract every HTTP(S) URL from message text in encounter order while retaining the original text unchanged and keeping the message as one capture.
- Classify Instagram, YouTube and Spotify deterministically from recognized hostnames. Set the single `sourcePlatform` only when the capture has exactly one distinct recognized platform; leave it unknown for unrecognized or mixed-platform input.
- Derive a conservative capture kind from the supplied text, URLs and attachment metadata, using `unknown` rather than guessing when there is insufficient evidence.
- Keep the module pure and deterministic by accepting the capture timestamp as input.
- Do not add persistence, Supabase, provider authentication, API routes, media retrieval, jobs, AI inference, source resolution or user-facing UI.

## Acceptance criteria

- [ ] Given one inbound message containing explanatory text and two URLs, when it is normalized, then exactly one capture is returned, both URLs remain in encounter order, and the original text and raw payload are unchanged.
- [ ] Given URLs on `instagram.com`, `youtu.be` or `youtube.com`, and `open.spotify.com`, when each single-platform capture is normalized, then its deterministic source platform is respectively `instagram`, `youtube` or `spotify`; an unrecognized or mixed-platform capture has no asserted source platform.
- [ ] Given an explicit user note, external message id, capture channel, capture timestamp and attachment metadata, when the input is normalized, then each value is retained separately and exactly in the normalized result.
- [ ] Given text-only, URL-only, attachment-only, mixed and empty inputs, when they are normalized, then their capture kinds are respectively conservative and valid, with empty input producing `unknown` instead of throwing.
- [ ] Given equivalent input values on repeated calls, when normalization runs, then it returns deeply equal output and performs no network, filesystem, database or clock access.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

This task deliberately preserves explicit `userNote` input but does not invent a note by splitting ordinary provider text. Channel adapters may supply a note only when their input makes that distinction explicit.
