---
id: "later-0037"
title: "Apply the approved Later colour palette to the iPhone theme tokens"
status: "blocked"
priority: 4
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Not machine-checkable: the palette is not approved. Dan rejected the cool/blue Coolors palette; Claude Design is exploring warm neutral/charcoal with restrained coral or olive/citron. Return to ready with the approved hex values written into this task."
blocked_by: []
serves: ["G4"]
intent: ""
touches:
  - "ios/LaterApp/Theme/**"
  - "ios/LaterAppTests/ThemeTests.swift"
labels: ["ios", "design"]
asks:
  - "decision: approve a v1 palette as hex values for the semantic tokens (background, surface, surfaceRaised, textPrimary, textSecondary, accent, onAccent, divider, destructive) in light and dark. Recommend: pick from the warm neutral/charcoal direction with one restrained accent; no yellow page backgrounds; keep onAccent text at ≥ 4.5:1 (the token test enforces it). Nothing else waits on this."
---

## Context

later-0023 made every colour a semantic token in one Theme file with provisional iOS system
colours, so the palette is a one-file swap that never blocks structural work. Design rules already
decided: system sans only, no serif; no yellow page backgrounds; main actions use the `accent`
token with `onAccent` text; text contrast ≥ 4.5:1 everywhere (small text on a mid-tone accent is
the classic failure — e.g. white on #0081A7 is only 4.47:1). The private Claude Design project is
a demo, not the spec: only the hex values written into this task count.

## Scope

**Does**
- Replace provisional token values with the approved light/dark values written into this task
  (by the orchestrator when Dan approves).
- Keep `ThemeTests` contrast and literal-scan tests passing; add a test asserting each token's
  exact approved value.

**Does not**
- Change layout, typography, copy or any screen code.

## Acceptance criteria

- [ ] Given the approved table, then each token resolves to its approved hex in light and dark —
      `LaterAppTests/ThemeTests.testApprovedPalette`.
- [ ] Given every text/background pair, then contrast ≥ 4.5:1 in both appearances —
      `ThemeTests.testTokenContrast` (existing).
- [ ] `ios-ci` and the Flow `ios/` check pass.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- If an approved pair fails 4.5:1, block with a `decision` ask proposing the nearest passing value
  (Recommend it); never lower the threshold.
