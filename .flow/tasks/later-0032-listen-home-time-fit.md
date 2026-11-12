---
id: "later-0032"
title: "Choose a 10, 15 or 30 minute listen on the Listen home"
status: "in_review"
priority: 2
project: "later"
owner: "codex-20261112-listen"
created: "2026-10-26"
started: "2026-11-12T22:18:04Z"
branch: "flow/later-0032-listen-home"
pr: "https://github.com/CandidDan/later/pull/66"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G3", "G4"]
intent: ""
touches:
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
labels: ["ios", "listen"]
notes:
  - "2026-11-12 implementation handoff: PR66 flow/later-0032-listen-home head 657e4f3e5ca2e7bda2dc32711bab8aa0254db9dc implements Listen preview, 10/15/30 choices above Play, longer items, Continue and ordered playback using existing TimeFitPlanner/ResumeStore/Player APIs. No planner/player/narration implementation changed. Strict local formatting passed; six new model tests and one UI test are written but hosted execution is pending. ShellUITests now expects the real empty-plan summary and About chrome is retained. CI runs on hosted macOS and GitHub Linux, no local Docker. Next: inspect exact-head ios-ci/full Linux gates/QA/security/code-review, repair any failure, then merge only after all required checks/reviewer findings clear. Do not duplicate overlapping workers. Signing and physical-device validation remain outstanding."
---

## Context

Listen is the app's home tab and the main daily action: "I have N minutes — play something I
saved." It joins three finished pieces: the ready-audio manifest (later-0030: actual durations),
resume positions (later-0031 `ResumeStore`), and `TimeFitPlanner.plan(target:candidates:)`
(later-0028: never overruns, never truncates, honest underfill, `tooLong` offered separately,
`summary` line). Playback starts through the later-0031 queue API.

## Scope

**Does**
- Listen tab: three large choices **10 min / 15 min / 30 min** (the `accent` token with
  `onAccent` text; ≥ 44 pt targets; labels as text, never colour alone).
- On choice: build candidates from items whose audio is fully rendered (actual duration, remaining
  from `ResumeStore`), run the planner, show the plan before playing: item titles + sources +
  each remaining time, the honest `summary` ("12 min of 15 — that's everything ready right now"),
  and **Play**. One tap on Play starts the queue and opens the Player.
- Underfill and empty states are explicit; when items are still preparing, say how many ("3 more
  are being prepared"). `tooLong` items appear under "Longer listens" with their real durations as
  separate, explicit choices.
- "Continue" row at top when an item is part-heard: title + remaining time, one tap resumes.
- Re-planning is deterministic for the same state (planner property), so the screen doesn't
  reshuffle on every visit.

**Does not**
- Estimate durations, include non-rendered items, trim or speed up items to fit, or auto-play
  without a tap. Change planner, player or narration code.

## Acceptance criteria

- [ ] Given rendered items and a 15-minute choice, then the shown plan equals the planner's output
      for those actual durations/remaining times — `LaterAppTests/ListenViewModelTests.testUsesPlannerWithActualDurations`.
- [ ] Given a not-yet-rendered narratable item, then it is never in the plan and is counted in
      "being prepared" — `ListenViewModelTests.testExcludesUnrenderedItems`.
- [ ] Given underfill or nothing ready, then the summary text states the real total vs the target
      or "Nothing's ready to listen to yet" — `ListenViewModelTests.testHonestStates`.
- [ ] Given a `tooLong` item, then it is listed under Longer listens with its duration and is only
      queued when explicitly chosen — `ListenViewModelTests.testLongerListensAreExplicit`.
- [ ] Given Play, then the player queue receives exactly the planned items in planned order —
      `ListenViewModelTests.testPlayQueuesPlanInOrder`.
- [ ] Given the simulator with stubbed ready items, the three choices, the plan preview and Play
      work end to end into the Player — `LaterAppUITests/ListenUITests`.
- [ ] `ios-ci` and the Flow `ios/` check pass with floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Colours come only from the Theme tokens (later-0023); the palette may change later without
  touching this screen.
