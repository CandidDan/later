---
id: "later-0023"
title: "Create the native iPhone app foundation, gated in hosted macOS and Linux CI"
status: "in_progress"
priority: 1
project: "later"
owner: "codex-later-0023-takeover"
created: "2026-10-26"
started: "2026-10-29T22:49:32Z"
branch: "flow/later-0023-ios-app-foundation"
pr: "https://github.com/CandidDan/later/pull/50"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "New CI workflow, Flow gate integration and a new toolchain the cloud worker can only validate through hosted macOS runs."
touches:
  - "ios/**"
  - ".github/workflows/ios-ci.yml"
  - ".flow/config.yml"
  - ".gitignore"
labels: ["ios", "ci", "foundation"]
asks:
  - "decision: once later-0023 merges, add the `ios-ci` check as a required status check on `main` (GitHub → Settings → Branches)? Recommend: yes — Flow's own gate cannot run macOS, so this is the only thing that makes a red iOS build block a merge."
  - "follow-up: canonical Flow (CandidDan/flow) `source_roots` cannot choose a runner, so a macOS check cannot be declared in .flow/config.yml; a `runs_on` field upstream would let ios-ci move inside the Flow gate."
  - "fyi: GitHub bills hosted macOS minutes at 10x against the account's included Actions minutes on a private repo; ios-ci skips its macOS work on PRs that do not touch iOS paths to stay inside the included allowance."
notes:
  - "2026-10-30: Dan explicitly authorized Codex to take over PR #50 from Claude. Hosted run 40265652494 built and passed UI tests but failed ThemeTests.testTokenContrast: onAccent/accent dark contrast 3.513 < 4.5. Preserve the test and correct semantic token pairing."
  - "2026-10-26 (orchestrator): first slice of the iOS v1 queue (later-0023…later-0037). Dan approved the general UX and playback/vision; the colour palette is NOT approved, so colours are replaceable semantic tokens only. The private Claude Design link is a demo, not a spec; this task stands alone without it."
  - "2026-10-26 (orchestrator): canonical Flow integration researched — `source_roots` (.flow/bin/source-roots.mjs) runs checks on the Linux gate runner only (runtime node|deno|none, no runner field). Adding jobs to flow-gates.yml is forbidden here. Therefore: Linux half via a `source_roots` entry (Flow gate), macOS half via the repo-owned `ios-ci.yml` workflow. Confirmed 2026-10-26 that a cloud session can push files under .github/workflows/."
  - "2026-10-26 (worker): branch flow/later-0023-ios-app-foundation pushed with LaterKit (AppInfo, ListeningDuration + tests), ios/.swift-format, ios/scripts/{check-coverage,pick-simulator}.mjs + node tests, linux-check.sh (green locally: Swift 6.4.0 pinned, sha256 from a GPG-verified swift.org download) and macos-ci.sh (stub-tested). Pins: macos-26 + Xcode 26.6 (image default; Xcode 27 is not on macos-26), XcodeGen 2.46.0 sha256-verified. NOT yet done: app target sources, project.yml, Config xcconfigs, ios-ci.yml, .flow/config.yml edits, README. Next: write those, push, open PR, iterate on the hosted ios-ci run."
  - "2026-10-26 (worker): all files for the task are written and pushed on flow/later-0023-ios-app-foundation; draft PR #50 (https://github.com/CandidDan/later/pull/50). linux-check.sh green locally (incl. the download-and-verify path with swift hidden). The macOS half is UNPROVEN until an ios-ci run is green — iterate by reading ios-ci runs on PR #50. Decision: xcconfigs attached per target in project.yml because XcodeGen project presets set SWIFT_VERSION 5.0 and outrank a project-level xcconfig. Next: fix ios-ci until green, run web gate, gh pr ready."
---

## Context

Later's v1 (VISION.md G4) is a daily-use iPhone app: Listen (choose something that fits 10/15/30
minutes), Saved, and a full Player, with background/offline narration and Siri. Nothing native
exists yet. The repo today is a Next.js + Supabase backend (`src/`, `supabase/`) whose Flow gate
runs `pnpm build/lint/test/coverage` on `ubuntu-latest`.

This task creates the iOS codebase skeleton and — the main deliverable — proves it is **built,
tested, linted and coverage-checked in hosted CI without any Apple account or signing**. It ships a
real but minimal app shell: honest empty states, no sample data, no controls that do nothing.

Later tasks build on the paths fixed here, so the layout below is part of the contract:

```
ios/
  project.yml              XcodeGen spec (the .xcodeproj is generated, never committed)
  Config/                  xcconfig files (Base, Debug, Release); bundle ids live here
  LaterApp/                SwiftUI app target sources (App/, Theme/, Features/<Area>/, Services/)
  LaterAppTests/           unit tests for the app target
  LaterAppUITests/         UI tests (simulator)
  LaterKit/                Swift package, Foundation-only, must also build/test on Linux
    Package.swift
    Sources/LaterKit/<Area>/
    Tests/LaterKitTests/<Area>/
  scripts/                 linux-check.sh, macos-ci.sh, check-coverage.mjs (+ node tests)
  .swift-format            formatter/lint config
  README.md                how to build and test, CI explanation
```

Fixed identifiers (later tasks rely on them; the signed-release task may change them in one place):
bundle id `now.notfor.later`, share extension `now.notfor.later.share`, app group
`group.now.notfor.later`, URL scheme `later`. Deployment target iOS 18.0, Swift 6 language mode,
SwiftUI app lifecycle, English (en-AU dates are the existing web convention).

## Scope

**Does**
- XcodeGen `ios/project.yml` with app target `Later`, `LaterAppTests`, `LaterAppUITests`, and the
  local package `LaterKit` linked into the app. Pin the XcodeGen version; CI installs that exact
  version (verified download, not an unpinned `brew install`).
- `LaterKit` package: Foundation-only (no SwiftUI/AVFoundation/Combine), so it compiles on Linux.
  Seed it with what the shell genuinely uses (e.g. `AppInfo`/build metadata, a `Duration`
  formatting helper the empty states use) and its tests. No speculative APIs.
- App shell: a `TabView` with **Listen** and **Saved** tabs. Each shows a truthful state for this
  build: it is not connected to an account yet, so it says so plainly (e.g. Listen: "Not connected
  yet — this build can't reach your saves." / Saved: same idea). No list rows, no sample items, no
  duration chips or buttons that do nothing. A small About sheet showing version/build is fine.
- Theme: `ios/LaterApp/Theme/` defines **semantic colour tokens** (`background`, `surface`,
  `surfaceRaised`, `textPrimary`, `textSecondary`, `accent`, `onAccent`, `divider`, `destructive`)
  in **one file** as the only place colour values appear. The palette is **not approved**: use iOS
  system semantic colours as provisional values (light + dark automatic). Typography: system font
  only via text styles (Dynamic Type); **no serif** (`.serif` design) and no custom fonts. No yellow
  page backgrounds. Swapping the palette later must be a one-file change.
- `ios/.swift-format` + lint via the toolchain's `swift format lint --strict --recursive`.
- `ios/scripts/check-coverage.mjs`: reads coverage JSON (llvm-cov export for LaterKit, `xccov`
  JSON for the app target) and exits non-zero below a floor. Floors: **LaterKit ≥ 80% lines,
  Later app target ≥ 40% lines**; floors live in the script and may only be raised. Node built-in
  `node --test` tests for it in `ios/scripts/`.
- Linux half — Flow gate: add a `source_roots` entry to `.flow/config.yml`
  (`path: "ios/"`, `check: "bash ios/scripts/linux-check.sh"`, `runtime: "none"`). The script, on a
  clean `ubuntu-latest` and in the cloud worker container: ensures a pinned Swift 6 toolchain
  (uses the preinstalled one if it matches, else downloads and verifies the official swift.org
  release), runs `swift format lint --strict` over `ios/`, `swift build` + `swift test
  --enable-code-coverage` for `LaterKit`, enforces the LaterKit floor, and runs `node --test
  ios/scripts/`. Must exit non-zero on any failure.
- macOS half — `.github/workflows/ios-ci.yml` (repo-owned; **not** a `flow-*` file): triggers on
  every `pull_request` to `main` and `workflow_dispatch`; one job named `ios-ci` on the newest GA
  GitHub-hosted macOS image (`macos-26`; use `macos-15` only if 26 is unavailable) with an
  explicitly selected, pinned Xcode. If the PR changes nothing under `ios/` or this workflow file,
  the job succeeds quickly with a log line saying it skipped (so it can be a required check);
  otherwise `ios/scripts/macos-ci.sh` generates the project, builds for the iOS Simulator with
  `CODE_SIGNING_ALLOWED=NO`, runs unit + UI tests on a simulator chosen from what the image
  actually has (resolved by script, never a hard-coded device that may be absent), enforces the
  app coverage floor, and uploads the `.xcresult` as an artifact. `permissions: contents: read`,
  no secrets, `concurrency` cancels superseded PR runs.
- `.flow/config.yml` `review.security_paths`: add `"ios/**"`, `"src/lib/app/**"`,
  `"src/lib/revisit/**"` (later tasks put session handling and exposure-gated content there).
- `.gitignore`: generated `*.xcodeproj`, `DerivedData`, `.build`, `*.xcresult`.
- `ios/README.md`: local commands, the two CI halves, coverage floors, how to swap the palette.

**Does not**
- Sign anything, use an Apple account, or touch TestFlight (later-0035).
- Talk to Supabase or any API (later-0027 onwards). No networking code.
- Touch `src/`, `supabase/`, `package.json`, any `flow-*` workflow or `.flow/bin/**`.
- Change `commands:` or `coverage_min` in `.flow/config.yml`.

## Acceptance criteria

- [ ] Given a clean checkout on GitHub-hosted macOS, when `ios-ci` runs on a PR that changes
      `ios/`, then it generates the project, builds for the simulator with signing disabled, runs
      unit and UI tests and passes — proved by the green `ios-ci` run linked in the PR, and by
      `ios/scripts/macos-ci.sh` exiting non-zero when any step fails (asserted in
      `ios/scripts/macos-ci.test.mjs` with a stubbed `xcodebuild` that returns failure).
- [ ] Given a PR touching nothing under `ios/` or `ios-ci.yml`, when `ios-ci` runs, then it passes
      without invoking `xcodebuild` — proved by `ios/scripts/macos-ci.test.mjs :: skips when no iOS
      path changed` (path decision is a testable function in the script).
- [ ] Given the app launches in the simulator, then the Listen and Saved tabs exist, each shows its
      "not connected yet" state, and no list rows or sample items exist — proved by
      `LaterAppUITests/ShellUITests.testTabsShowHonestEmptyStates`.
- [ ] Given every semantic text/background token pair (`textPrimary`/`textSecondary` on
      `background`/`surface`/`surfaceRaised`, `onAccent` on `accent`), then each meets WCAG 4.5:1
      in both light and dark appearance — proved by `LaterAppTests/ThemeTests.testTokenContrast`.
- [ ] Given the app sources, then colour values appear only in the Theme token file and no serif or
      custom font is used — proved by `LaterAppTests/ThemeTests.testNoColourLiteralsOrSerifOutsideTheme`
      (locates `ios/LaterApp/` from `#filePath`, which simulator tests can read on the host).
- [ ] Given coverage below a floor, when `check-coverage.mjs` runs, then it exits non-zero naming
      the target and both numbers; at/above the floor it exits zero — proved by
      `ios/scripts/check-coverage.test.mjs`.
- [ ] Given the Flow gate on `ubuntu-latest`, when the `ios/` source root check runs, then
      `ios/scripts/linux-check.sh` lints, builds and tests `LaterKit` and enforces its floor —
      proved by the green Flow `source_roots` matrix job for `ios/` on the PR, and by
      `node .flow/bin/flow-doctor.mjs` reporting no uncovered top-level source tree.
- [ ] Given `LaterKit`, then it imports only Foundation — proved by `linux-check.sh` building it
      on Linux (any Apple-only import fails that build).
- [ ] build + lint + test pass for the existing web gate (`pnpm build/lint/test/coverage`),
      unchanged.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- The cloud worker has no Mac. Iterate on the macOS half by pushing to the PR and reading the
  `ios-ci` run (logs and `.xcresult` artifact). Run `linux-check.sh` locally before each push.
- If a hosted run reveals the chosen macOS image or Xcode is unavailable, pick the newest available
  GA pair and record it in `ios/README.md`; that is routine, not a blocker.
- If the hosted macOS run cannot start at all (Actions disabled for macOS, minutes exhausted),
  that is a billing/account matter: set `blocked` with a `decision` ask carrying the exact
  error and `Recommend:`; do not substitute a self-hosted runner or any paid service.
- Do not commit the generated `.xcodeproj`.
