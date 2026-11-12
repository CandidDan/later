---
id: "later-0029"
title: "Show Saved on iPhone from the private library, with Open original for anything not narratable"
status: "in_progress"
priority: 2
project: "later"
owner: "codex-later-saved-20261112"
created: "2026-10-26"
started: "2026-11-12T17:33:27Z"
branch: "flow/later-0029-saved-library"
pr: "https://github.com/CandidDan/later/pull/63"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G2", "G3", "G4"]
intent: ""
touches:
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
  - "ios/LaterKit/Sources/LaterKit/Library/**"
  - "ios/LaterKit/Tests/LaterKitTests/Library/**"
labels: ["ios", "saved"]
notes:
  - "2026-11-12T17:50Z: Implemented Saved on flow/later-0029-saved-library, PR #63. Paged private library, honest status/reason labels, detail Open original/confirmed consume, protected per-user cache and persisted request IDs; guard late async responses with AuthService session generation to prevent cache recreation after sign-out. Automatic reconnect replays queued actions but does not unexpectedly navigate; the user can tap Open original again after replay. Existing semantic tokens and shell retained; no Listen redesign or playback. Seven new Foundation library tests pass in an isolated local Swift 6.0.3 package; all Swift sources pass that formatter. Full local suite does NOT pass on 6.0.3: pre-existing MainActor XCTest discovery is incompatible. Required pinned Linux/macOS checks and PR reviewers are pending; no claim of device installation or Apple signing. Using hosted checks under Dan's standing authorization. Next: inspect final PR head checks, fix failures/findings, and merge only after all required checks and reviews verify that exact head."
---

## Context

Saved is the user's view of what they've kept — not a guilt pile (VISION.md NG1): newest first,
quiet, each item recognisable, and each honest about whether Later can narrate it. Data comes from
`GET /api/app/library?before=&limit=` (later-0026): `{items: [{captureId, title, creator, source,
sourceUrl, savedAt, kind, listen: {state: narratable|preparing|open_original, reason?, wordCount?,
textVersion?}}], nextCursor}`. **Fetching a page records exposure for every item returned**, so the
app pages on demand (no background crawling of the whole library) and caches what it has fetched.

Open original uses the existing action endpoint `POST /api/revisit/actions/{captureId}` with
`{requestId: <uuid>, action: "open"}` → `{destination}` (409 `unavailable` when there is no safe
destination). "Done with this" uses the same endpoint with `action: "consume"` (explicit only; never
inferred). Auth via the later-0027 `LaterAPIClient`.

## Scope

**Does**
- LaterKit `Library/`: Codable models for the library contract, a closed `ListenState`/`reason`
  enum (unknown values decode to `open_original` + `unknown`, never crash), and a paging cursor.
- Saved tab: list newest first, infinite scroll by explicit page fetch, pull to refresh. Row: title
  (or a factual fallback: source + "saved <date>"), source, saved date (en-AU), and a status label:
  "Ready to narrate · ~N min" is **not** allowed (no estimates) — use "Can be narrated",
  "Preparing…", or "Open original" with a plain reason ("Video", "Social post", "Behind a paywall",
  "Only part of the text was available", "Couldn't read this page", "Not an article").
- Item detail sheet: title, creator, source, saved date, the reason, **Open original** (records the
  action, then opens the returned destination in Safari / the owning app via `openURL`) and
  **Done with this** (consume, with confirmation). Retries reuse the same `requestId`.
- Offline: the last fetched pages are cached (file protection
  `completeUntilFirstUserAuthentication`, removed on sign-out) and shown with "Offline — showing what
  you last loaded"; actions taken offline are queued with their `requestId` and sent later.
- Empty state: "Nothing saved yet. Share a link to Later, or send it on WhatsApp or email." — only
  when the server returned an empty first page.
- Accessibility: VoiceOver reads title, source and status; Dynamic Type up to AX5 without clipping.

**Does not**
- Narrate, render audio or play anything (later-0030/0031). Show the Listen tab's content.
- Show summaries or model-inferred text as content.

## Acceptance criteria

- [ ] Given library JSON with each `listen` state and reason, then rows show the exact label and no
      duration estimate — `LaterAppTests/SavedViewModelTests` + LaterKit decoding tests (Linux).
- [ ] Given an unknown state/reason value, then decoding yields `open_original`/`unknown` —
      `LaterKitTests/Library/LibraryDecodingTests`.
- [ ] Given scrolling to the end, then exactly one next-page request uses `nextCursor`, and no
      request is made when `nextCursor` is null — `SavedViewModelTests.testPagesOnDemandOnly`.
- [ ] Given Open original, then the action is posted before navigation and the returned destination
      is opened; given 409, an "isn't available" message and no navigation —
      `ItemActionTests`.
- [ ] Given an action while offline, then it is queued and later sent once with the same
      `requestId` — `ItemActionTests.testOfflineActionRetriesIdempotently`.
- [ ] Given no network after a successful load, then cached rows show with the offline notice;
      after sign-out the cache is gone — `SavedCacheTests`.
- [ ] Given a stubbed library, the Saved tab renders rows and the detail sheet in the simulator —
      `LaterAppUITests/SavedUITests`.
- [ ] `ios-ci` and the Flow `ios/` check pass with floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Stubbed responses in tests are fixtures, never shipped as in-app sample data.
