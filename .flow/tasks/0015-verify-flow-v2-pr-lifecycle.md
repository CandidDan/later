---
id: "later-0015"
title: "Verify the Flow v2 pull-request lifecycle"
status: "in_progress"
priority: 3
project: "later"
owner: "codex-flow-v2-proof-20260925"
created: "2026-09-25"
started: "2026-09-25T09:35:27Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["maintenance"]
touches: ["FLOW_V2_PROOF.md", "src/lib/flow-v2-proof.test.ts"]
labels: ["maintenance", "flow", "proof"]
notes: []
---

## Context

Flow was upgraded from 1.2.0 to 2.0.0. The human explicitly requested one live,
small pull request to prove that the v2 lifecycle works end to end: draft creation,
ready-for-review hand-off, review checks, merge, and the automatic `done` transition.

## Scope

- Add a small root-level proof document identifying Flow 2.0.0 and this task.
- Add a focused Vitest assertion that reads the proof document and `.flow/VERSION`.
- Open the task PR as a draft, mark it ready only after the local gate passes, observe the
  review checks, merge it, and confirm the task becomes `done` on `main`.
- Do not change product runtime behaviour, Flow infrastructure, Flow configuration, or any
  task file on the feature branch.

## Acceptance criteria

- [ ] Given the proof artifact and Flow metadata, when `src/lib/flow-v2-proof.test.ts` runs,
  then it asserts `.flow/VERSION` is exactly `2.0.0` and the artifact identifies this as the
  `later-0015` Flow v2 lifecycle proof.
- [ ] Given the proof PR is initially a draft, when it is marked ready for review, then the
  Flow review checks run and publish their verdicts on the PR.
- [ ] Given the proof PR passes its required checks, when it is merged, then `flow-done`
  changes `later-0015` to `done` on `main` without a hand-written task transition.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

None. This is deliberately a disposable maintenance proof with no product behaviour.
