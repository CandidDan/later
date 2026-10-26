---
id: "later-0030"
title: "Prepare faithful narration audio on the iPhone for offline listening"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for later-0029 (Saved, library models and the signed-in API client)."
blocked_by: ["later-0029"]
serves: ["G3", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "AVFoundation speech rendering, file protection for locked-device use, and exposure-before-download ordering."
touches:
  - "ios/project.yml"
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
  - "ios/LaterKit/Sources/LaterKit/Narration/**"
  - "ios/LaterKit/Tests/LaterKitTests/Narration/**"
  - "ios/README.md"
labels: ["ios", "narration", "offline", "research-safeguard"]
asks:
  - "fyi: v1 narration uses Apple's on-device voices (AVSpeechSynthesizer rendered to audio files): no paid TTS vendor or new credential is allowed, and it works offline. A hosted neural voice later would be a separate vendor/budget decision."
---

## Context

Decision recorded (orchestrator, 2026-10-26): **narration audio is rendered on the device** with
`AVSpeechSynthesizer.write(_:toBufferCallback:)` into local audio files. Reasons: buying a TTS
service or adding credentials is not permitted for v1; on-device voices need no server audio
storage, work offline, and give **actual** audio durations once rendered — which the time-fit
planner (later-0028) requires.

The text comes from `GET /api/app/narrations/{captureId}` (later-0026), which **records exposure
server-side before returning anything**: `{captureId, textVersion, title, byline, siteName,
sourceUrl, intro, paragraphs, outro, wordCount}`; 409 `{status:"open_original", reason}` when not
narratable; 404 when not owned. Because exposure precedes the download, later offline playback of
that text/audio is already covered — the app must never obtain narration text any other way.

## Scope

**Does**
- `NarrationStore` (app): for library items with `listen.state == narratable`, downloads narration
  text, renders audio, and records a local manifest per item: `captureId, textVersion, voice id,
  audio file, actual duration (from the rendered file), rendered at`. Only fully rendered items are
  "ready". A changed `textVersion` re-renders.
- Rendering: speak `intro`, then each paragraph **verbatim in order**, then `outro`, as separate
  utterances with a short pause between paragraphs; chunk long paragraphs at sentence boundaries
  only (never drop or alter words). Language from the device locale unless the text's language is
  known; prefer an installed Premium/Enhanced voice for that language, else the default voice; the
  chosen voice id is stored. Output AAC `.m4a` (or CAF if AAC conversion is unavailable) in
  Application Support/Narrations with file protection `completeUntilFirstUserAuthentication` and
  excluded from iCloud backup.
- When: preparation runs while the app is active and opportunistically via `BGProcessingTask`
  (requires `BGTaskSchedulerPermittedIdentifiers` in Info.plist via `project.yml`); a bounded
  queue (default: the 10 newest narratable items + anything the user explicitly taps "Prepare").
  Storage cap 500 MB, oldest-heard first eviction, never evict the item playing.
- Saved row/detail: "Ready to listen · 12 min" (actual rendered duration), "Preparing audio…",
  or the existing Open original state. A text download returning 409 updates the item to Open
  original with the reason.
- Attribution in UI is explicit: "Narrated by Later with an iPhone voice · Source: <site>".
- Sign-out deletes all narration files and manifests.

**Does not**
- Play audio (later-0031) or choose a listen (later-0032). Summarise, shorten or speed up text.
  Upload audio anywhere.

## Acceptance criteria

- [ ] Given narration text, then the rendered utterance sequence is intro, every paragraph in
      order, outro, and concatenating utterance texts reproduces the paragraphs exactly —
      `LaterKitTests/Narration/NarrationScriptTests` (chunking is pure LaterKit logic, Linux too).
- [ ] Given a long paragraph, then chunks split only at sentence boundaries and rejoin to the
      original — `NarrationScriptTests.testChunkingIsLossless`.
- [ ] Given a rendered file, then the manifest duration equals the file's measured duration (not
      an estimate) — `LaterAppTests/NarrationStoreTests.testDurationIsMeasured` (renders a short
      fixture text in the simulator).
- [ ] Given the API is never called for an item, then no narration text or audio exists for it;
      narration text is only obtained from the narrations endpoint — `NarrationStoreTests`
      (stubbed client asserts the only content source).
- [ ] Given a 409 response, then no audio is rendered and the item shows Open original with its
      reason — `NarrationStoreTests.testOpenOriginalOnConflict`.
- [ ] Given a new `textVersion`, then the item is re-rendered and the old file removed —
      `NarrationStoreTests.testReRendersOnNewVersion`.
- [ ] Given saved files, then their protection class is `completeUntilFirstUserAuthentication` and
      they are excluded from backup; sign-out removes them — `NarrationFileTests`.
- [ ] Given the cap is exceeded, then eviction removes oldest-heard items but never the playing one
      — `NarrationStoreTests.testEviction`.
- [ ] `ios-ci` and the Flow `ios/` check pass with floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- If simulator CI cannot render speech to a file at all (no voices on the image), keep the
  rendering seam injectable, test it with a deterministic fake renderer in CI, and leave the one
  real-render test running where a voice exists (skip with a logged reason only when the image has
  zero voices). Real-device rendering is verified in later-0036.
