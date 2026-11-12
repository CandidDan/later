---
id: "later-0028"
title: "Plan a listen that fits 10, 15 or 30 minutes from actual ready audio, honestly"
status: "in_review"
priority: 2
project: "later"
owner: "dot-later-0028-timefit"
created: "2026-10-26"
started: "2026-11-12T11:47:51Z"
branch: "flow/later-0028-time-fit-planner"
pr: "https://github.com/CandidDan/later/pull/62"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G4"]
intent: ""
touches:
  - "ios/LaterKit/Sources/LaterKit/TimeFit/**"
  - "ios/LaterKit/Tests/LaterKitTests/TimeFit/**"
labels: ["ios", "listen", "logic"]
notes:
  - "2026-11-12 worker handoff: implemented planner and 16 TimeFit regressions on flow/later-0028-time-fit-planner, draft PR #62, head b080ae342718bd1dd415115c0a02eb960a03d820. Local pnpm build and lint pass (four existing Flow warnings); Linux iOS gate passes 22 LaterKit tests, 100% coverage and 20 script tests. Local aggregate tests reached 800 passes but Docker-backed database suites cannot run here; the separate browser install received an empty/truncated Chrome archive. Remote pre-ready gate run 43214218336 and macOS run 43214191130 are pending. Next: verify both runs for this exact head, update PR validation, and mark PR ready only after they pass; then let Flow QA/code/security checks run. Do not mark task state in_review manually. The approved conservative ceil-second feasibility contract is intentional; actual fractional output and maximum actual total within that feasible set are retained."
  - "2026-11-12 (orchestrator decision): rendered audio and scrubbed positions are fractional, so an unconstrained exact subset optimum at 200 items has no practical bounded guarantee. Approved ceil-second feasibility budgets with actual-duration maximisation, retained fractional output, and explicit combination/too-long underfill reasons. Do not claim an unconstrained fractional optimum. Added oracle and boundary regressions to the acceptance criteria."
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
    optimisation over conservative whole-second budgets: budget each remaining duration with
    `ceil(remaining)`, then maximise the actual summed remaining among subsets whose summed budgets
    fit. Retain actual fractional durations in the output. This reserves less than one second per
    selected item and is not an unconstrained fractional optimum. Cap input at 200 and document
    bounded dynamic programming over at most 1800 seconds);
  - ties broken deterministically: include an in-progress item (position > 0) if one fits, then
    prefer older `savedAt`, then `id`;
  - order: in-progress item first, then oldest saved first;
  - never splits, trims or speeds up an item.
- `ListenPlan { items: [PlannedItem(id, remaining)], total, target, shortfall, fill: .full |
  .under(reason) | .empty(reason), tooLong: [ListenCandidate] }`. `.full` only when `shortfall`
  ≤ 60 s. Reasons: `.notEnoughReady` (every individually fitting candidate is included),
  `.noCombinationFits` (some ready candidates cannot be included together within the budget), or
  `.nothingReady` (no ready candidates). An empty plan with only too-long candidates uses
  `.empty(.noCombinationFits)` and says that nothing fits this slot, not that nothing is ready.
  `tooLong` lists candidates whose `remaining` alone exceeds the target so the UI can offer them
  explicitly as longer listens (never auto-included).
- `ListenPlan.summary` produces the user-facing honest line, e.g. "12 min of 15 — that's
  everything ready right now" / "Nothing's ready to listen to yet", using LaterKit's duration
  formatter (whole minutes, rounded **down** for totals so a plan never claims more than it has).
  Only say "everything ready right now" when all ready candidates are included; distinguish
  omitted combinations and longer listens honestly. Prefer maximum actual duration first; the
  in-progress preference applies only to equal-duration optimal plans.

**Does not**
- Know about audio files, networking or UI. Estimate durations from word counts.

## Acceptance criteria

- [ ] Given candidates whose conservative whole-second budgets can sum to ≤ target, then the
      plan's actual total never exceeds the target and is the maximum actual total achievable
      among those budget-feasible subsets — `TimeFitPlannerTests.testNeverOverruns
      AndMaximisesFill` (includes a brute-force oracle over random sets ≤ 12 items,
      fractional durations/positions, deterministic ties and a 200-candidate bound regression).
- [ ] Given a partly heard item, then its remaining (not full) duration is used and, if it fits, it
      is first in the plan — `testInProgressUsesRemainingAndLeads`.
- [ ] Given total ready leaves more than 60 seconds unfilled and all budgets fit the target,
      then `fill == .under(.notEnoughReady)`, all fitting items are
      included and `summary` states the real total and the target — `testHonestUnderfill`.
- [ ] Given 400 + 400 seconds for a 600-second slot, then `.under(.noCombinationFits)` and
      summary does not claim all ready items were included — `testHonestCombinationUnderfill`.
- [ ] Given only items longer than the slot, then `.empty(.noCombinationFits)` and summary says
      no ready audio fits this slot — `testOnlyLongerListens`.
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
