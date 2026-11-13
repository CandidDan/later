# Later for iPhone

The native iPhone app (VISION.md G4). This build signs an existing user in with a PKCE magic link.
**Listen** and **Saved** remain honest empty states until their data tasks land. CI builds,
tests, lints and coverage-checks the app without an Apple account, signing or real credentials.

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

## Sign-in setup

1. In the existing Supabase project, open **Authentication → URL Configuration → Redirect URLs**
   and add exactly `later://auth-callback`. Account creation remains disabled in the app.
2. Copy `ios/Config/Secrets.example.xcconfig` to `ios/Config/Secrets.xcconfig`. The latter is ignored
   by git. Fill in the existing project's `SUPABASE_URL`, browser-safe public `SUPABASE_ANON_KEY`
   (legacy anon JWT or publishable key), and `LATER_API_BASE_URL` (`https://notfor.now`). Preserve the
   `https:/$()/` spelling: it prevents xcconfig from treating the URL as a comment. Never use a
   service-role or secret key. These public values become part of the distributed app.

`supabase-swift` is pinned to **2.55.6**, with only its **Auth** product linked into the app target.
LaterKit has no Supabase dependency and remains Foundation-only. Release builds reject missing,
placeholder, insecure URL and privileged-key configuration before compiling. Debug simulator tests
use an in-memory auth backend and no network. A placeholder-configured ordinary launch explains
that sign-in is not configured; it never silently signs in or contacts the placeholder host.

Open the magic link on the same iPhone that requested it. PKCE stores a device-bound verifier;
opening the link elsewhere cannot complete that sign-in. If you request another link, use the
latest email. The existing server remains the authority for the one allowed Later user.

### Session and cache boundaries

- Session and PKCE verifier: Keychain service `now.notfor.later.auth`, access group
  `$(AppIdentifierPrefix)now.notfor.later.shared`, accessibility
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Signed builds must provision the group.
- App group: `group.now.notfor.later`. Only unsigned **Debug simulator** builds with
  `CODE_SIGNING_ALLOWED=NO` use the default Keychain group and omit the app-group container.
  Missing signed entitlements fail closed instead of silently changing storage.
- No email or tokens are written to user defaults, files or logs. The email shown in About comes
  from the Supabase session. The SDK refreshes expired tokens on demand. LaterKit retries a 401
  once after refresh; a second 401 or any 403 ends the session. Its transport rejects redirects
  before sending credentials to another URL and does not cache responses or cookies.
- Future user downloads belong in `LaterUserData` beneath Caches, Application Support or tmp, or
  in that directory beneath the app-group root/Library Caches/Library Application Support.
  Sign out removes these directories and all auth-service Keychain items, even when network
  revocation fails. A local deletion failure blocks another sign-in until cleanup is retried.
- Create a new `URLSessionLaterAPIClient` after a new sign-in. A client that reported
  `sessionEnded` is permanently invalidated; do not reuse it for another user's session.

`AuthServiceTests` exercise the real pinned SDK against an injected HTTP responder: OTP account
creation is false, PKCE challenge and callback exchange are verified, session persistence is
checked, and storage failures cannot display a signed-in shell. `AuthUITests` cover sign-in,
callback, generic errors and sign-out with Debug-only test state. Real signed-device sign-in is
verified by later-0036 after redirect setup; this task does not change the hosted project.

### On-device narration (later-0030)

Saved prepares the ten newest narratable items, plus items explicitly requested with **Prepare**.
Only `GET /api/app/narrations/{captureId}` supplies text; that endpoint records exposure before
returning it. Intro, full paragraphs and outro are spoken in order at the system default rate.
Long paragraphs split conservatively at sentence endings without changing any characters.
Installed enhanced/premium voices matching the device language are preferred. No voice vendor,
credential, upload or server-side audio storage is involved.

Audio is written to protected Application Support/LaterUserData/<user>/Narrations directories,
excluded from backups. AAC export is attempted; complete CAF audio is retained if conversion is
unavailable. A manifest is published only after the entire file is closed and its duration is
measured. Interrupted work never appears ready. Sign-out removes the entire user-data tree;
late download/render completions cannot publish into a signed-out session.

Preparation runs serially while active and opportunistically under the registered
`now.notfor.later.prepare-narration` BGProcessingTask. iOS decides when background time is
available; foreground preparation does not depend on it. Expiration cancels rendering and retains
the queue for retry. The 500 MiB audio cap evicts oldest-heard files first, then oldest unplayed
files. A file marked as playing is protected; if no space can be reclaimed, preparation remains
retryable. Playback integration must set `playingID` before opening the file, clear it after
closing it, and call `markHeard` (later-0031). This task does not play audio.

Simulator tests use a real short speech render when any installed voice exists, otherwise log a
skip for that single test. Deterministic CAF fixtures test the store, measured durations, version
replacement, queue bounds, conflict handling, eviction and sign-out. The simulator does not
prove hardware file protection or background scheduling on a physical phone; those remain in
later-0036. All iOS execution uses hosted macOS, and database tests use Linux Actions.

## Siri: physical iPhone verification

After installing a signed build, sign in and prepare at least two articles in Saved. Unlock once
since the last restart; protected audio and the device-only Keychain session remain available
while locked after that first unlock. The App Intent uses local session restoration and cached
library/audio only. It never refreshes tokens, drains actions, downloads or generates narration.

1. Check Shortcuts contains **Play Later**, with optional 10, 15 and 30 minute choices.
2. With headphones connected and the screen locked, say “Hey Siri, play Later”. Confirm audio
   starts without opening the app. Pause part-way; repeat and confirm it resumes the same item.
3. Say “Play a 10 minute Later”, then repeat for 15 and 30. Confirm the queue matches Listen's
   plan for that slot and the spoken duration describes the prepared audio, including underfill.
4. Enable airplane mode, lock again and repeat. Verify audio, headphone controls and lock-screen
   controls work. Background-launch behavior must also be checked after the app has been closed.
5. With nothing prepared, confirm Siri reports nothing ready and starts no audio. With only a
   recording longer than the slot, confirm it asks for a longer listen instead of claiming empty.
6. Sign out and repeat: no private audio should play. After a reboot before first unlock, access
   may be denied; unlock once and retry. Record results/build in task later-0036.

Simulator unit tests and App Intents metadata extraction do not prove locked-device voice
invocation. That remains a signed physical-device release check.

### Share extension (in progress)

`LaterShare` is embedded in the app and built with extension-only APIs. It accepts one web URL
or plain text, hosts the existing themed save sheet, and keeps success visible until Done.
It uses the same App Group and Keychain service/session key as the app; configuration failure
never falls back to a private outbox. The extension does not link app library or narration code.
Unsigned simulator builds prove compilation; real Safari/WhatsApp sharing requires signed
App Group and Keychain entitlements and remains part of device release verification.
`LaterShareTests` compiles the production extension sources in a dedicated simulator test
harness. CI enforces 40% line coverage across every Swift file in `LaterShare/`, excluding
all test/generated sources; missing or duplicate production-file coverage fails. Shared app
services retain the existing app coverage gate. The extension is also built and embedded by
`Later`, but these unit tests do not claim signed execution inside Safari or WhatsApp.
The app now retries account-bound shares during library launch/foreground/reconnect and existing
background processing. Rejected shares leave a content-free, account-specific notice on disk
before removal. Signed-out shares remain queued until Saved asks for confirmation of the destination account.
Confirmation applies only to the displayed request IDs; subsequent shares remain unassigned.
An immutable, protected assignment record prevents an interrupted writer or a different
account from transferring an already assigned request.

### Simulator screenshots

The hosted `ios-ci` run exports retained XCTest attachments into the
`Later-simulator-screenshots` artifact, alongside the original `Later-xcresult`.
The export manifest maps each image to its test. Share captures render the production
SwiftUI sheet in the simulator test harness with synthetic input and injected storage/API;
they do not prove signed sharing from Safari or WhatsApp. Inspect images before publishing,
label them simulator output, and select only changed representative screens.
