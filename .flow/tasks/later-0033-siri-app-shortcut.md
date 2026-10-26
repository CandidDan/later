---
id: "later-0033"
title: "Start a Later listen hands-free with a named Siri App Shortcut, even when locked"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for later-0032 (Listen planning) which this shortcut invokes."
blocked_by: ["later-0032"]
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
