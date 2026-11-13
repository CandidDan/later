---
id: "later-0034"
title: "Save a link or text to Later from the iPhone share sheet"
status: "in_progress"
priority: 2
project: "later"
owner: "codex-20261113-share"
created: "2026-10-26"
started: "2026-11-13T03:34:39.716Z"
branch: "flow/later-0034-ios-share-extension"
pr: "https://github.com/CandidDan/later/pull/68"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G1", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "New app-extension target sharing auth state; extension memory/time limits and offline retry."
touches:
  - "ios/project.yml"
  - "ios/LaterShare/**"
  - "ios/LaterShareTests/**"
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterKit/Sources/LaterKit/Capture/**"
  - "ios/LaterKit/Tests/LaterKitTests/Capture/**"
  - "ios/README.md"
labels: ["ios", "capture", "security"]
notes:
  - "2026-11-13T03:40Z continuation: Claimed ready 0034 after reading main protocol/store and checking open PRs (only 59 infra). Published groundwork to flow/later-0034-ios-share-extension, draft PR68 head a3991bc4b5205fc61aa6ab642eedb8cff22f589d. CaptureRequest enforces UTF-16 and encoded-byte backend limits; CaptureDelivery reuses authenticated API client, validates receipts and retries same requestId; drainer filters owner; CaptureFileOutbox uses atomic protected per-request files. Added portable validation/delivery and iOS disk tests. NOT integrated: no extension target/UI/auth, no foreground/background hooks, no Saved invalid notice yet. 20 existing Node script tests passed; local Swift absent (linux-check stops at Debian13 unsupported pinned Swift 6.4); no Swift/format/iOS pass claimed. Hosted macOS run 43360307736 in progress; draft gates/reviews skipped. NEXT: inspect that run, fix compilation; finish project.yml LaterShare target and shared auth/theme/file source selection plus ShareViewModelTests; integrate lifecycle drains with session-generation cancellation and durable invalid notices, safely assign signed-out pending shares only with clear account intent. Outbox directory intentionally separate from UserCacheCleaner pending integration decision: bind owner and ensure sign-out never transfers data to a new account. Add cancellation/concurrency tests. Extension coverage task note requires 40% floor but ios/scripts paths absent from touches: resolve through orchestrator metadata under delegated routine authority before editing scripts. Then run hosted Linux/macOS, mark ready only after feature complete, inspect final-head independent reviews before merge. Local untracked files mirror published connector commit; fetch remote into fresh worktree if necessary. Apple signing remains unverified; keep automation enabled because implementation work remains."
---

## Context

Capture must stay zero-friction: WhatsApp and email keep working unchanged, and the share sheet is
added. Backend (later-0025): `POST /api/app/captures` with bearer token, body `{requestId: uuid,
url?, text?, note?, sharedAt?}` → 201/200 `{captureId, repeated}`; 400/401/503 otherwise; retries
with the same `requestId` are idempotent. Session: Supabase session in the shared Keychain access
group `$(AppIdentifierPrefix)now.notfor.later.shared` (later-0027). App group
`group.now.notfor.later`; extension bundle id `now.notfor.later.share`.

## Scope

**Does**
- Share Extension target `LaterShare` (activation: web URLs and plain text; max 1 URL). UI: a
  compact sheet with the item's URL/text, an optional note field, **Save** and Cancel; system font,
  Theme tokens.
- Save: create `requestId`, write the pending capture to an outbox in the App Group container
  (file protection `completeUntilFirstUserAuthentication`), then attempt the POST with the shared
  session. Success → "Saved for Later ✓" and dismiss. Offline/5xx → "Saved — will send when you're
  online" (honest) and leave it in the outbox. 401/no session → "Open Later to sign in" (kept in
  the outbox).
- The main app drains the outbox on launch, foreground and background refresh, reusing each
  `requestId`; removes entries on 200/201; drops entries on 400 with a visible "Couldn't save"
  notice in Saved.
- LaterKit `Capture/`: outbox model + request validation (same limits as the backend) — Linux
  testable.
- The extension never reads library or narration content.

**Does not**
- Share images/files/PDFs. Add capture channels beyond `ios_share`. Change backend code.

## Acceptance criteria

- [ ] Given a shared URL and note, then the POST body is `{requestId, url, note, sharedAt}` and
      success shows "Saved for Later ✓" — `LaterShareTests/ShareViewModelTests`.
- [ ] Given no network, then the item is in the outbox and the message says it will send later;
      when the app drains the outbox, the same `requestId` is sent exactly once on success —
      `LaterAppTests/OutboxDrainTests`.
- [ ] Given a 200 `repeated:true`, then the entry is removed without duplicate UI —
      `OutboxDrainTests.testRepeatedIsSuccess`.
- [ ] Given 401, then "Open Later to sign in" and the entry stays —
      `ShareViewModelTests.testSignedOut`.
- [ ] Given 400, then the entry is dropped and Saved shows "Couldn't save" —
      `OutboxDrainTests.testInvalidIsDroppedVisibly`.
- [ ] Given text over the limit or a non-http(s) URL, then Save is disabled with a reason —
      `LaterKitTests/Capture/CaptureValidationTests` (Linux + macOS).
- [ ] Given the project, then `LaterShare` builds unsigned for the simulator in `ios-ci` and its
      tests run there — the `ios-ci` run on the PR.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- App Group and shared Keychain only work on signed builds; on unsigned simulator CI, inject the
  container/keychain seams. Real sharing from Safari/WhatsApp is verified in later-0036.
- `check-coverage.mjs` floors apply to the app target; add the extension target to the report at
  the same 40% floor.
