---
id: "later-0023"
title: "Create the native iPhone app foundation, gated in hosted macOS and Linux CI"
status: "done"
priority: 1
project: "later"
owner: "codex-later-0023-handoff"
created: "2026-10-26"
started: "2026-11-03T01:18:50Z"
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
  - "follow-up: once later-0023 merges, add the `ios-ci` check as a required status check on `main` (GitHub → Settings → Branches)? Recommend: yes — Flow's own gate cannot run macOS, so this is the only thing that makes a red iOS build block a merge."
  - "follow-up: canonical Flow (CandidDan/flow) `source_roots` cannot choose a runner, so a macOS check cannot be declared in .flow/config.yml; a `runs_on` field upstream would let ios-ci move inside the Flow gate."
  - "fyi: GitHub bills hosted macOS minutes at 10x against the account's included Actions minutes on a private repo; ios-ci skips its macOS work on PRs that do not touch iOS paths to stay inside the included allowance."
notes:
  - "2026-11-12 continuation: Dan explicitly confirmed CI control after being asked about merging #58 despite failed statuses. PR #58 merged successfully as 53b1e3330e0fb2cf14ddc4ec9e6a359cdaa2170f. Rerun of failed PR #50 review workflow 41558941262 accepted; outcome pending. Dan forbids local Docker: run container/database checks on GitHub Actions Linux, iPhone builds on hosted macOS. Dan explicitly authorizes the existing v2 designs as the working baseline and sensible implementation decisions; do not initiate a fresh design round or use newer unapproved designs. Locate actual v2 artifacts before implementing visual screens, do not invent their contents. Next: inspect latest review attempt and final-head checks for PR #50; merge if green under standing authorization, then progress the existing v1 queue to a real testable app. TestFlight still requires verified Apple signing access."
  - "2026-11-12 delegation: Dan explicitly asked Codex to take Later through to a testable v1, take control of CI, make sensible decisions and not wait for routine approvals. This authorizes implementing the existing v1 queue, CI repairs, and merging verified changes; previous notes saying no merge authorization are superseded. Preserve quality/security gates, use on-device narration, and treat palette as a routine delegated decision rather than a human blocker. Apple membership/signing access must be verified, not assumed. Inspected PR #58: build gate succeeds, all three independent reviewer comments explicitly PASS, and QA job 125746152562 fails only because base Flow 4.0.1 lacks enforce. Attempt to merge canonical repair #58 was rejected by automatic approval review because GitHub check statuses remain failing. Do not bypass or retry that merge through another tool. Need explicit approval for this specific CI bootstrap merge, or a genuinely verified repair path that makes checks pass. PR #50 remains unmerged. After resolving #58, rerun failed review workflow 41558941262 for #50, verify final-head checks, merge, and let Flow unblock tasks 0026/0027/0028; continue each task in fresh sessions. Do not claim v1 or TestFlight is delivered."
  - "2026-11-03 review failure diagnosis: PR #50 qa, code-review and security model comments all report PASS, but each job fails afterward because shared workflow v4 invokes flow-review.mjs enforce and main carries Flow 4.0.1 without that command. Build/test/coverage, Linux iOS and macOS checks are green. Ran supported flow-sync, successful run 41584260724, producing repair PR https://github.com/CandidDan/later/pull/58 to adopt Flow 4.1.0 (includes enforce and its tests). No project implementation changed. Next: review upgrade PR #58 and its checks; once it merges, rerun failed workflow 41558941262 on PR #50. Reviews load helpers from main, so rerunning #50 before adoption cannot fix the failure. No merge or deployment performed."
  - "2026-11-03 handoff: Dan explicitly approved task-state-only pushes to main. Resolved the cloud-runner decision by using hosted Ubuntu: final head 633165b78ddd286c23430f49fb7a8616ff303424 passes complete Flow gates (build, lint, database/browser tests, coverage and Linux iOS source-root check), run https://github.com/CandidDan/later/actions/runs/41386694209. Hosted macOS ios-ci also passes on the same head, run https://github.com/CandidDan/later/actions/runs/41386698930. Rebased existing branch flow/later-0023-ios-app-foundation cleanly onto main f546ca9; no implementation changes. Local iOS script tests 20/20 pass; flow-doctor reports no uncovered source tree. PR #50 description contains validation evidence. Next action: mark PR #50 ready, allowing flow-status to set in_review and CI to run qa/code-review/security; human reviews and merges after checks. No merge or deployment performed."
  - "2026-11-01 follow-up: rebased-head hosted ios-ci 41278535984 is green: 5 app unit tests including unchanged contrast test, 2 UI tests including honest empty states, app coverage 100%. PR description updated. Dan reports saving cdn.playwright.dev policy change, but environment_status still reports applied revision 1, and /etc/codex/network-policy.json still lacks that host; Playwright retry returns 403 Domain forbidden. Requested applying/restarting the running environment and also allowing api.github.com so hosted Ubuntu flow-gates.yml can be dispatched to avoid local Docker storage limits. Local log /tmp/later-0023-browser-retry.log. Existing cloud-gate block remains; PR stays draft. No merge or deployment invoked."
  - "2026-11-01 validation handoff: PR #50 remains draft. Rebased and lease-pushed existing branch flow/later-0023-ios-app-foundation as 3d4ac35092516bc00834033f8724a35059005024 on main d35ad44; contrast fix preserved, no implementation changes needed. Original ios-ci 40968884959 is green (5 app unit tests, 2 UI tests, app coverage 100%); fresh rebased run 41278535984 has now passed (see latest note). Linux linux-check.sh passes (LaterKit 6 tests, coverage 100%; 20 script tests); pnpm build passes, lint 0 errors / 4 unchanged Flow warnings; flow-doctor only warns about inactive intent layer. Both pnpm test and test:coverage finished red: 64 files / 725 tests pass, 2 database suites fail setup, 1 file / 10 tests skipped. Separate pinned-image pull proves Docker extraction fails with no space left on device; fallback registry Forbidden. Playwright install is independently forbidden at cdn.playwright.dev; browser gates and complete coverage are unproven. PR description records criterion proofs and blockers. No builds on Dan’s Mac, no merge or deployment invoked. Exact next action: repair cloud networking/capacity or dispatch hosted flow-gates.yml on the existing branch, verify ios-ci 41278535984, rerun all required gates, update PR evidence and gh pr ready (connected GitHub ready tool if shell API remains blocked). Current protocol has no generated board; old board-regeneration note is obsolete."
  - "2026-11-01 reproducible cloud tools: pnpm 11.19.0 installed under /workspace/later-tools/node_modules/.bin; frozen install uses --store-dir /workspace/later-tools/pnpm-store. Run pnpm with --config.verify-deps-before-run=false because its automatic dependency check otherwise tries to rewrite modules into unwritable home paths. Checksum-verified Swift 6.4 is /workspace/later-tools/swift/usr/bin; set PATH accordingly, CLANG_MODULE_CACHE_PATH and SWIFT_MODULECACHE_PATH to /workspace/later-tools/clang-cache. Logs: /tmp/later-0023-{linux,build,lint,test,coverage,docker,browser-install,doctor}.log. These environment selectors change no source or gate coverage."
  - "2026-11-01 Codex resumed under Dan’s explicit takeover and main task-metadata authorization. Cloud Linux execution and git access verified; connected GitHub plugin confirms hosted ios-ci run 40968884959 succeeded for 395da87. Shell api.github.com is denied by the cloud proxy; use connected GitHub tools for Actions and PR operations. The cloud-resume decision is resolved. Branch protection remains a post-merge follow-up. Rebase onto 3821385 is clean; local Linux iOS gate, web build and lint passed. Required browser download currently blocked by network policy at cdn.playwright.dev; Dan has been asked to allow that host. Web test and coverage gates still pending. No merge or deployment authorized."
  - "2026-10-30 Codex handoff: claimed with Dan’s authorization. Fixed ColorToken.onAccent to black in dark appearance, white in light, on existing branch; commit 395da87e24d00a2fc15ac4c90f87cf9277e04408. Existing contrast test remains unchanged. Hosted ios-ci run 40968884959 started; result not yet verified. PR #50 remains draft. Next: inspect that run, fix any remaining failures, run linux-check.sh and configured web gates in cloud, rebase latest main and repeat gates as necessary, update PR checklist, gh pr ready, regenerate board. No attached cloud executor here; shell gh cannot connect to api.github.com. Board regeneration is outstanding. No merge or deployment performed."
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
