---
id: "later-0033"
title: "Start a Later listen hands-free with a named Siri App Shortcut, even when locked"
status: "in_progress"
priority: 2
project: "later"
owner: "codex-20261113-siri"
created: "2026-10-26"
started: "2026-11-12T23:18:46.763Z"
branch: "flow/later-0033-siri-app-shortcut"
pr: "https://github.com/CandidDan/later/pull/67"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "App Intents audio playback while locked has narrow platform rules (authentication policy, foreground continuation, file protection)."
touches:
  - "ios/project.yml"
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
  - "ios/README.md"
labels: ["ios", "siri"]
notes:
  - "2026-11-13: Implemented local-only Siri App Intent and shared app/coordinator runtime on flow/later-0033-siri-app-shortcut, draft PR #67, head 48816e30a049e0d80e06f8d08c64e23a7f4d1258. Existing workers/checkouts untouched. prepareLocal restores existing device-only after-first-unlock Keychain session plus Saved/narration caches without network; foreground resume still refreshes normally. Added action/config/phrase tests and physical-device README steps. Strict formatting of all changed Swift with available 6.0.3 and git diff --check passed. Full local linux-check stopped before tests because pinned Swift 6.4 is absent on Debian; no Docker run locally. Hosted macOS run 43328279594 is in progress. Flow gates/reviews skip draft. NEXT: inspect PR67 macOS jobs/logs, fix compile/test failures on same branch, strengthen actual intent-to-player queue/network integration proof (current action tests inject Listen start seam; network test restores cached Saved without prepared audio). Then mark ready to run hosted Linux Docker/database and independent QA/security/code-review, repair findings, verify exact final head before merge. Do not claim locked voice works until later-0036 signed device tests. Apple signing remains unverified. git push lacked credentials; commits/branch were published using GitHub connector, so local worktree has equivalent uncommitted files and should be compared with remote before resetting."
---

## Context

While running, Dan says "Hey Siri, play Later" (or "…a 15 minute Later") with the phone locked and
headphones in, and narration starts. Ready audio is local and protected
`completeUntilFirstUserAuthentication` (later-0030), so it is readable while locked after first
unlock; planning is `TimeFitPlanner` via the Listen view model (later-0032); playback via the
later-0031 queue API.

## Scope

**Does**
- App Intents (no SiriKit intents extension): `PlayLaterIntent` conforming to `AudioPlaybackIntent`
  with an optional `minutes` parameter (`ListenSlot` App Enum: 10 / 15 / 30). Behaviour: if a part-
  heard item exists and no minutes given → resume it; otherwise plan for the given slot (default
  15) and start playback. `openAppWhenRun = false`; authentication policy allows running while
  locked; the intent touches only local data (no network, no Keychain read that requires unlock).
- `AppShortcutsProvider` with phrases that include the app name, e.g. "Play \(.applicationName)",
  "Listen to \(.applicationName)", "Play a \(\.$minutes) minute \(.applicationName)", short title
  "Play Later", system image `headphones`.
- Siri dialog is honest: "Playing 12 minutes from Later — that's everything ready" / "Nothing's
  ready to listen to yet in Later" (and no playback).
- `ios/README.md` gains a manual verification script for the physical device (used in later-0036).

**Does not**
- Add a Watch app, widgets, or network calls from the intent. Change the planner or player.

## Acceptance criteria

- [ ] Given ready items and `minutes = 10`, when the intent performs, then the player queue equals
      the planner's 10-minute plan and playback starts — `LaterAppTests/PlayLaterIntentTests.testPlansAndPlays`.
- [ ] Given a part-heard item and no minutes, then it resumes that item —
      `PlayLaterIntentTests.testResumesInProgress`.
- [ ] Given nothing ready, then the dialog says so and nothing plays —
      `PlayLaterIntentTests.testNothingReady`.
- [ ] Given the intent's configuration, then `openAppWhenRun` is false, it is an
      `AudioPlaybackIntent`, and it makes no network request (URLProtocol stub fails the test on
      any request) — `PlayLaterIntentTests.testRunsLockedWithoutNetwork`.
- [ ] Given the App Shortcuts provider, then every phrase contains `.applicationName` and the
      shortcut is titled "Play Later" — `LaterAppTests/AppShortcutsTests`.
- [ ] `ios-ci` and the Flow `ios/` check pass with floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Voice invocation on a physical locked iPhone cannot be tested in CI; it is a required manual
  check in later-0036.
