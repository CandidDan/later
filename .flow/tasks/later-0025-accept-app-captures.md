---
id: "later-0025"
title: "Accept authenticated captures from the iPhone app"
status: "in_progress"
priority: 2
project: "later"
owner: "claude-worker-later-0025"
created: "2026-10-26"
started: "2026-10-26T05:30:17Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G1", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "New authenticated write endpoint that persists through the service-role path; ownership must come only from the verified session."
touches:
  - "src/app/api/app/captures/**"
  - "src/lib/capture/**"
labels: ["backend", "capture", "security"]
notes:
  - "2026-10-26 (orchestrator): backend half of iOS share capture; later-0034 (share extension) consumes it. Parallel-safe with later-0023 and later-0024 (touches checked disjoint)."
---

## Context

V1 keeps WhatsApp and email capture and adds the iOS share sheet. Today captures arrive only via
signed webhooks (`/api/inbound/whatsapp`, `/api/inbound/email`) and are persisted by
`persist_capture_with_intent_job(p_user_id, p_capture_channel, p_external_message_id,
p_capture_kind, p_raw_text, p_user_note, p_source_platform, p_captured_at, p_raw_payload,
p_assets)` (`src/lib/capture/persist.ts`, service-role client), which also enqueues intent work and
returns `{capture_id, intent_job_id, created}`; `capture_channel` is free text.

App requests authenticate the way the revisit API does (`src/lib/revisit/server.ts`,
`src/lib/research/access.ts`): `Authorization: Bearer <Supabase access token>`, verified with
`auth.getUser`, and accepted only when the user id equals `RESEARCH_USER_ID`. Responses use the
revisit conventions (`Cache-Control: private, no-store`, `Vary: Authorization`,
`X-Content-Type-Options: nosniff`, `{"error":"Unauthorized"}` / `{"error":"Unavailable"}`).

## Scope

**Does**
- `POST /api/app/captures` (Node runtime, dynamic). JSON body:
  `{ requestId: uuid, url?: string, text?: string, note?: string, sharedAt?: ISO-8601 }`.
  At least one of `url`/`text`; `url` must be an absolute `http(s)` URL ≤ 2000 chars; `text`,
  `note` ≤ 16000 chars each; unknown keys rejected; body ≤ 64 KiB.
- Owner is **only** the verified session user; nothing in the body can set it.
- Persist via the existing RPC with `p_capture_channel = 'ios_share'`,
  `p_external_message_id = requestId` (idempotency), `capture_kind` derived with the existing
  normaliser in `src/lib/capture/normalize.ts` (url / text / mixed), `p_raw_text` = url and text
  joined exactly as the normaliser does for WhatsApp, `p_user_note` = note, `p_captured_at` =
  server time (client `sharedAt` kept only inside `raw_payload`), `p_assets = []`.
- Responses: `201 {captureId, repeated:false}` on first save, `200 {captureId, repeated:true}`
  on a retry with the same `requestId`; `400 {"error":"Invalid"}` for shape errors; 401; 503 when
  persistence is unavailable. Never echo the submitted content.
- Idempotency already exists: `captures` has a unique index on `(user_id, capture_channel,
  external_message_id)` and the RPC returns the existing capture with `created = false`. No
  migration is needed or allowed under this task.

**Does not**
- Accept files/images (v1 share extension sends URL/text only).
- Change WhatsApp/email routes, the intent pipeline, or any migration.
- Build the iOS extension (later-0034).

## Acceptance criteria

- [ ] Given a valid session and `{requestId, url}`, when posted, then one capture with channel
      `ios_share`, owner = session user, and an intent job exists, and the response is 201 with its
      id — `src/app/api/app/captures/route.test.ts`.
- [ ] Given the same `requestId` again, then no second capture is created and the response is 200
      `repeated:true` with the same id — same file.
- [ ] Given a body containing a `userId`/`user_id` or any unknown key, then 400 and nothing is
      persisted — same file.
- [ ] Given no token, an invalid token, or a valid token for a user other than `RESEARCH_USER_ID`,
      then 401 and nothing is persisted — same file.
- [ ] Given neither url nor text, a non-http(s) url, or an oversize field/body, then 400 — same file.
- [ ] Given persistence fails, then 503 with no content echoed and headers `private, no-store` —
      same file.
- [ ] build + lint + test + coverage pass.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Put request validation/persistence glue in `src/lib/capture/app-share.ts` (+ test); the route
  file stays thin. Reuse the research access helper; do not copy it.
