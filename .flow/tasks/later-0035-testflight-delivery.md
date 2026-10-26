---
id: "later-0035"
title: "Deliver signed builds to TestFlight from CI without exposing credentials"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Not machine-checkable: needs Dan's Apple Developer Program team and App Store Connect setup and GitHub secrets listed in the task (no worker may buy a membership or create credentials). Also needs later-0023 merged. Return to ready when the asks are answered."
blocked_by: []
serves: ["G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Code signing and secret handling in CI."
touches:
  - ".github/workflows/ios-testflight.yml"
  - "ios/project.yml"
  - "ios/Config/**"
  - "ios/scripts/**"
  - "ios/README.md"
labels: ["ios", "release", "signing", "security"]
asks:
  - "decision: is there an active Apple Developer Program membership (team) Later can ship under, and may the workflow use it? Recommend: yes, using your existing team; if none exists, enrolling is a paid purchase only you can make — say so and this task stays blocked while all simulator work continues."
  - "decision: create these yourself (never paste values into chat, issues or PRs): (1) App IDs `now.notfor.later` and `now.notfor.later.share` with the App Groups capability, and App Group `group.now.notfor.later`; (2) an App Store Connect app record for `now.notfor.later`; (3) an App Store Connect API key with the Admin role (needed for cloud-managed signing); (4) GitHub environment `testflight` (required reviewer: you) holding secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` (the .p8 contents); (5) repository variables `APPLE_TEAM_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `LATER_API_BASE_URL` (public values already used by the web app). Recommend: do all five, then move this task to ready."
---

## Context

All earlier iOS work is proved unsigned on the simulator (later-0023 `ios-ci`). Daily use on
Dan's iPhone, Siri while locked, the share extension and the App Group/Keychain sharing need a
**signed** build installed through TestFlight. This task adds a separate, manually triggered
release workflow. It is deliberately isolated so the absence of an Apple account never blocks
simulator work.

Identifiers (from later-0023): bundle id `now.notfor.later`, extension `now.notfor.later.share`,
app group `group.now.notfor.later`, Keychain group
`$(AppIdentifierPrefix)now.notfor.later.shared`, URL scheme `later`.

## Scope

**Does**
- `.github/workflows/ios-testflight.yml`: `workflow_dispatch` only (input: release notes, optional),
  `environment: testflight`, `permissions: contents: read`, same pinned macOS image/Xcode and
  XcodeGen as `ios-ci`. Steps: run the full `ios/scripts/macos-ci.sh` tests first (no upload if
  any fail) → write `Secrets.xcconfig` from repository **variables** → archive Release with
  `-allowProvisioningUpdates` and App Store Connect API-key authentication
  (`-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`), `DEVELOPMENT_TEAM`
  from `APPLE_TEAM_ID` → `-exportArchive` with an `ExportOptions.plist` whose destination uploads
  to App Store Connect.
- Secret hygiene: the .p8 is written to `$RUNNER_TEMP` with mode 600 from the secret via an env
  var (never a command-line argument, never echoed, `set +x`), removed in an `always()` step; no
  secret in artifacts; logs contain no secret values (GitHub masking plus no `echo`).
- Build number = `github.run_number` + a fixed offset recorded in `ios/README.md`; marketing version
  from `ios/Config/Base.xcconfig`.
- `ios/scripts/release-check.mjs` (+ `node --test`): fails before archiving when any required
  variable/secret name is missing (checks presence only, never prints values) or when the commit is
  not on `main`.
- README: one-page TestFlight runbook (how to trigger, where to watch processing, how to add
  Dan as internal tester).

**Does not**
- Create Apple accounts, keys, certificates or profiles by hand in the repo; commit any secret,
  certificate, profile or `.p8`; submit to App Store review; use fastlane match or any paid service.

## Acceptance criteria

- [ ] Given missing required names, then `release-check.mjs` exits non-zero listing only names —
      `ios/scripts/release-check.test.mjs`.
- [ ] Given the workflow file, then it triggers only on `workflow_dispatch`, uses environment
      `testflight`, has read-only contents permission, and never interpolates a secret into a `run:`
      command line — `ios/scripts/release-workflow.test.mjs` (parses the YAML text).
- [ ] Given a dispatched run on `main` with the asks completed, then the build is uploaded and
      appears in TestFlight processing — the linked green `ios-testflight` run and its build number
      recorded in the PR.
- [ ] Given a failing test, then the run stops before archiving — `release-workflow.test.mjs`
      asserts step order/conditions.
- [ ] `ios-ci` and the Flow `ios/` check pass.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- A workflow file only becomes dispatchable from the default branch; the first real upload happens
  after this PR merges. Until then, prove the workflow by dispatching it from the PR branch with
  `ref` if GitHub allows, otherwise record the post-merge run in a `notes` entry and the release
  task (later-0036) re-checks it.
- If Dan prefers a different bundle id, change it in `ios/Config/Base.xcconfig` only (all targets
  derive from it) in this task.
