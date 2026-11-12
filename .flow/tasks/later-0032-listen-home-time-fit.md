---
id: "later-0032"
title: "Choose a 10, 15 or 30 minute listen on the Listen home"
status: "done"
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
  - "2026-11-12 hosted build repair: initial head 657e4f3e5ca2e7bda2dc32711bab8aa0254db9dc passed QA/security/code-review and Linux iOS check, but macOS run 43319382871 failed during test compilation because LibraryItem was ambiguous in ListenViewModelTests. Head c9773dffce8806a246573ce68d9d2d056ed2ea2a explicitly qualifies LaterKit.LibraryItem in model/tests. No iOS runtime tests have passed for this task yet. Final-head hosted checks/reviews must finish before merge. Nonblocking review decisions: preparation count reflects queued/current preparation rather than promising work for failed/unqueued items; Continue picks oldest part-heard save deterministically; resume path matches coordinator's per-account path. Exact next: inspect current head CI/reviews, repair failures and verify all gates before merging PR66."
  - "2026-11-12 final-head proof: dae49ab44e19bf97de2ded58f4018c58269e654e passed hosted macOS run 43320371795 (89 app tests, all 6 ListenViewModelTests, 13 UI tests including ListenUITests and About/empty-state regressions; Later line coverage 89.99%). Linux run 43320372333 passed build/lint, database/backend tests 808 passed with 3 existing skips, browser suites and 80.66% lines; Linux LaterKit 52 tests, 97.01% lines. QA/security/code-review/guide PASS, no blocking findings; review submissions/threads empty; all final-head checks/statuses successful except intentional intent-review skip, mergeable_state clean. Current implementation shows total duration for partly heard items and singular preparation wording. No physical-device, signing or installation proof. Final approval to merge is already delegated by Dan."
  - "2026-11-12 completed handoff: PR66 squash-merged as 91fdcf24bce1153746ef92510671867b1a2904c1 after verifying exact head dae49ab44e19bf97de2ded58f4018c58269e654e, all applicable checks/statuses green, mergeable_state clean and latest reviewers with no blockers. Flow marked later-0032 done automatically. Next: read current protocol/tasks/PRs, claim later-0033 Siri when flow-unblock releases it, or existing ready later-0034 share extension; avoid overlapping app workers. ListenViewModel.live(coordinator) builds ready-only candidates from actual manifest durations and ResumeStore positions; select(slot), playPlan(), playItem(id) are callable on MainActor. Snapshot collection flushes current position through the existing player before reading per-account playback.json. Time selector remains above Play with existing theme tokens. Nonblocking follow-ups: centralize resume-file URL with coordinator when that task scope permits; hide empty summary when a read error is displayed; Continue deterministically picks oldest part-heard save. No planner/player/narration implementation was changed. No installation, signing or physical-device proof; eligible code tasks remain, so keep continuation enabled."
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

- [x] Given rendered items and a 15-minute choice, then the shown plan equals the planner's output
      for those actual durations/remaining times — `LaterAppTests/ListenViewModelTests.testUsesPlannerWithActualDurations`.
- [x] Given a not-yet-rendered narratable item, then it is never in the plan and is counted in
      "being prepared" — `ListenViewModelTests.testExcludesUnrenderedItems`.
- [x] Given underfill or nothing ready, then the summary text states the real total vs the target
      or "Nothing's ready to listen to yet" — `ListenViewModelTests.testHonestStates`.
- [x] Given a `tooLong` item, then it is listed under Longer listens with its duration and is only
      queued when explicitly chosen — `ListenViewModelTests.testLongerListensAreExplicit`.
- [x] Given Play, then the player queue receives exactly the planned items in planned order —
      `ListenViewModelTests.testPlayQueuesPlanInOrder`.
- [x] Given the simulator with stubbed ready items, the three choices, the plan preview and Play
      work end to end into the Player — `LaterAppUITests/ListenUITests`.
- [x] `ios-ci` and the Flow `ios/` check pass with floors met.

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
