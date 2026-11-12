# Later for iPhone

The native iPhone app (VISION.md G4). This build is the foundation: a SwiftUI shell with
**Listen** and **Saved** tabs that say plainly they are not connected yet, and the CI that
builds, tests, lints and coverage-checks it without an Apple account or signing.

```
ios/
  project.yml       XcodeGen spec — the .xcodeproj is generated, never committed
  Config/           xcconfigs; the bundle ids, app group and URL scheme live in Base.xcconfig
  LaterApp/         the app target (App/, Theme/, Features/<Area>/, Services/)
  LaterAppTests/    unit tests, hosted in the app
  LaterAppUITests/  UI tests, run on a simulator
  LaterKit/         Swift package, Foundation-only, builds and tests on Linux too
  scripts/          linux-check.sh, macos-ci.sh, check-coverage.mjs, pick-simulator.mjs (+ tests)
  .swift-format     formatter / lint config
```

| Fixed identifier | Value |
|---|---|
| App bundle id | `now.notfor.later` |
| Share extension | `now.notfor.later.share` |
| App group | `group.now.notfor.later` |
| URL scheme | `later` |
| Deployment target | iOS 18.0, Swift 6 language mode |

## Local commands

On a Mac with Xcode 26.6 and XcodeGen 2.46.0:

```sh
xcodegen generate --spec ios/project.yml   # writes ios/Later.xcodeproj
open ios/Later.xcodeproj
bash ios/scripts/macos-ci.sh               # exactly what ios-ci runs (expects /Applications/Xcode_26.6.app)
```

Anywhere with Swift 6.4 (Linux or macOS):

```sh
bash ios/scripts/linux-check.sh            # what the Flow gate runs for ios/
swift test --package-path ios/LaterKit     # LaterKit only
node --test 'ios/scripts/*.test.mjs'       # the CI script tests
swift format --in-place --recursive --configuration ios/.swift-format ios/LaterApp ios/LaterAppTests ios/LaterAppUITests ios/LaterKit/Sources ios/LaterKit/Tests
```

## CI: two halves

Flow's gate runs on Linux only and cannot choose a runner, so iOS CI is split:

| | Linux half | macOS half |
|---|---|---|
| Where | Flow gate, `source_roots` entry `ios/` in `.flow/config.yml` | `.github/workflows/ios-ci.yml`, job `ios-ci` |
| Runner | `ubuntu-latest` (and the cloud worker) | `macos-26`, Xcode 26.6 |
| Script | `ios/scripts/linux-check.sh` | `ios/scripts/macos-ci.sh` |
| Does | `swift format lint --strict` over all Swift; build + test LaterKit; LaterKit coverage floor; node tests | XcodeGen generate; simulator build with `CODE_SIGNING_ALLOWED=NO`; unit + UI tests; app coverage floor; `.xcresult` artifact |
| Runs when | every PR | every PR; skips (passing, with a log line) when nothing under `ios/` or the workflow changed |

Toolchains are pinned and verified, never floating:

- **Swift 6.4.0** on Linux — the preinstalled toolchain when it is that version, otherwise the
  swift.org release checked against a SHA-256 in `linux-check.sh`.
- **XcodeGen 2.46.0** on macOS — the release zip checked against a SHA-256 in `macos-ci.sh`.
- **Xcode 26.6** on `macos-26` — the image default; Xcode 27 is not on that image. If the image
  drops it, pick the newest GA image/Xcode pair, update `XCODE_VERSION` in `macos-ci.sh`,
  `runs-on` in `ios-ci.yml` and this file.
- **Simulator** — never hard-coded: `pick-simulator.mjs` takes the first iPhone on the newest
  installed iOS runtime that the SDK supports.

## Coverage floors

Line coverage, enforced by `ios/scripts/check-coverage.mjs`. The floors live in that script and
may only be raised.

| Target | Floor | Measured from |
|---|---|---|
| LaterKit | 80% | `swift test --enable-code-coverage` (llvm-cov export, `Sources/` only) |
| Later app | 40% | `xcrun xccov view --report --json` on the test `.xcresult` (unit + UI tests) |

## Theme: swapping the palette

The palette is **not approved**. Every colour the app shows comes from one file,
`LaterApp/Theme/ColorToken.swift`, as a semantic token (`background`, `surface`,
`surfaceRaised`, `textPrimary`, `textSecondary`, `accent`, `onAccent`, `divider`, `destructive`).
The values today are provisional iOS system colours, so light and dark resolve automatically.

To swap the palette, change the values in that file — nothing else. Two tests guard it:

- `ThemeTests.testTokenContrast` — every text/background pair is at least 4.5:1 (WCAG AA) in
  light and dark.
- `ThemeTests.testNoColourLiteralsOrSerifOutsideTheme` — no colour value outside the token file,
  no serif or custom font anywhere. Type is the system font through text styles (Dynamic Type).
