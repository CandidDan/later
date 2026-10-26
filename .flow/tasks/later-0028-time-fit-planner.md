---
id: "later-0028"
title: "Plan a listen that fits 10, 15 or 30 minutes from actual ready audio, honestly"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for later-0023 (the LaterKit package and its Linux/macOS gates)."
blocked_by: ["later-0023"]
serves: ["G4"]
intent: ""
touches:
  - "ios/LaterKit/Sources/LaterKit/TimeFit/**"
  - "ios/LaterKit/Tests/LaterKitTests/TimeFit/**"
labels: ["ios", "listen", "logic"]
notes:
  - "2026-10-26 (orchestrator): pure logic, Foundation-only, Linux-testable. Parallel-safe with later-0027 (touches disjoint: TimeFit dirs only)."
---

## Context

Listen's core promise (VISION.md G4): pick 10, 15 or 30 minutes and get something from your saves
that fits — using the **actual durations of audio already rendered on the device** (and, for a
partly heard item, its actual remaining time), never estimates, never silently running over, never
cutting an item short, and saying honestly when there isn't enough ready to fill the slot.

This task is the planner only, in `LaterKit` (Foundation-only, runs in both CI halves from
later-0023). The Listen screen (later-0032) calls it.

## Scope

**Does**
- `ListenCandidate { id: String, savedAt: Date, audioDuration: TimeInterval, position:
  TimeInterval }` — only items whose audio is fully rendered locally are candidates (the caller
  guarantees this; the planner rejects `audioDuration <= 0` or `position` outside
  `[0, audioDuration)`). `remaining = audioDuration - position`.
- `TimeFitPlanner.plan(target: ListenSlot (.ten, .fifteen, .thirty), candidates:) -> ListenPlan`:
  - chooses a subset whose summed `remaining` is **≤ target** and as large as possible (exact
    optimisation over seconds; candidate counts in v1 are small, cap input at 200 and document it);
  - ties broken deterministically: include an in-progress item (position > 0) if one fits, then
    prefer older `savedAt`, then `id`;
  - order: in-progress item first, then oldest saved first;
  - never splits, trims or speeds up an item.
- `ListenPlan { items: [PlannedItem(id, remaining)], total, target, shortfall, fill: .full |
  .under(reason) | .empty(reason), tooLong: [ListenCandidate] }`. `.full` only when `shortfall`
  ≤ 60 s. Reasons: `.notEnoughReady` (everything that fits is included) or `.nothingReady`.
  `tooLong` lists candidates whose `remaining` alone exceeds the target so the UI can offer them
  explicitly as longer listens (never auto-included).
- `ListenPlan.summary` produces the user-facing honest line, e.g. "12 min of 15 — that's
  everything ready right now" / "Nothing's ready to listen to yet", using LaterKit's duration
  formatter (whole minutes, rounded **down** for totals so a plan never claims more than it has).

**Does not**
- Know about audio files, networking or UI. Estimate durations from word counts.

## Acceptance criteria

- [ ] Given candidates whose remaining times can sum to ≤ target, then the plan's total never
      exceeds the target and is the maximum achievable — `TimeFitPlannerTests.testNeverOverruns
      AndMaximisesFill` (includes a brute-force oracle over random sets ≤ 12 items).
- [ ] Given a partly heard item, then its remaining (not full) duration is used and, if it fits, it
      is first in the plan — `testInProgressUsesRemainingAndLeads`.
- [ ] Given total ready < target, then `fill == .under(.notEnoughReady)`, all fitting items are
      included and `summary` states the real total and the target — `testHonestUnderfill`.
- [ ] Given no candidates, then `.empty(.nothingReady)` and an empty plan — `testEmpty`.
- [ ] Given an item longer than the target, then it is in `tooLong` and not in `items` —
      `testTooLongIsOfferedNotIncluded`.
- [ ] Given identical inputs in any order, then the plan is identical — `testDeterministic`.
- [ ] Given invalid durations/positions, then they are rejected (thrown or excluded with reason as
      documented) — `testRejectsInvalidCandidates`.
- [ ] Flow `ios/` source-root check (Linux) and `ios-ci` pass; LaterKit coverage ≥ floor.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- `Package.swift` picks up new files in existing targets automatically; if it does not, block
  rather than editing `Package.swift` (later-0027 owns it while both are live).
