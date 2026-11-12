---
id: "later-0027"
title: "Sign in to Later on iPhone with a magic link and keep the session safely"
status: "in_progress"
priority: 2
project: "later"
owner: "dot-build-later-signin"
created: "2026-10-26"
started: "2026-11-12T11:47:20Z"
branch: "flow/later-0027-ios-sign-in"
pr: "https://github.com/CandidDan/later/pull/61"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Authentication and token storage shared with an app extension."
touches:
  - "ios/project.yml"
  - "ios/Config/**"
  - "ios/LaterApp/**"
  - "ios/LaterAppTests/**"
  - "ios/LaterAppUITests/**"
  - "ios/LaterKit/Package.swift"
  - "ios/LaterKit/Sources/LaterKit/API/**"
  - "ios/LaterKit/Tests/LaterKitTests/API/**"
  - "ios/README.md"
labels: ["ios", "auth", "security"]
notes:
  - "2026-11-12: Follow-through fixed Apple SDK Sendable compile failure by creating FileManager inside cache cleanup. Head fb58eaa8 passed hosted ios-ci 43214563195 (28 unit tests, 5 UI tests, zero failures, 91.48% app line coverage) and full Flow gate 43214978036. PR #62 merged during verification, so this branch was rebased without conflicts onto main 3744fdb; current remote head is 67e859c3521f8f0cc335a40de1d0e0c8d64e3f19. Combined cloud Linux check passed with 36 Swift tests, 96.74% LaterKit coverage and 20 script tests. Fresh hosted checks for the rebased head are pending; PR #61 remains draft. Next: finish exact-head checks, update the PR acceptance checklist and mark ready for independent Flow review only after green results. No local Docker or local Mac tests; no real login/configuration changes."
  - "2026-11-12: Implemented iPhone PKCE sign-in, shared Keychain session/verifier, guarded sign-out/cache cleanup, Release config validation, signed-in shell and Foundation bearer API client on flow/later-0027-ios-sign-in, draft PR #61, head e56d540b44d5db6bbc43a622a598f91324889336. Cloud Linux source-root gate passes: strict Swift formatting, 20 Swift tests including 14 API tests, 94.44% LaterKit line coverage, 20 script tests. macOS ios-ci run 43213876507 is in progress; app compilation/UI tests and full Flow gates are not yet verified. Supabase Auth product only is pinned to 2.55.6; no hosted auth configuration or real account was changed. Real signed-device login remains later-0036. Next: inspect ios-ci 43213876507 and fix any app compile/test failures on this branch; run full workflow_dispatch flow-gates for the exact final head, update PR acceptance checklist, then mark ready for independent Flow review only once build/test gates pass. Cloud worktree is later-signin; current local commit f232510 has the same tree as remote e56d540, so fetch remote branch and align history before further commits. Swift 6.4 lives at /workspace/shared/later-swift-6.4.0/usr/bin; cloud source-root command uses CLANG_MODULE_CACHE_PATH=/workspace/shared/signin-cache/clang and SWIFTPM_MODULECACHE_OVERRIDE=/workspace/shared/signin-cache/module. No local Mac tests or Docker; parent coordinates hosted dispatch using authorized Mac CLI."
---

## Context

The app must act as the one existing Later user. The backend already accepts only
`Authorization: Bearer <Supabase access token>` for `RESEARCH_USER_ID` (see
`src/lib/research/access.ts`, `src/lib/revisit/server.ts`); the API never refreshes tokens, so the
client must; any 401/403 means the session ended. Web sign-in uses
`signInWithOtp({ email, options: { emailRedirectTo, shouldCreateUser: false } })`
(`src/app/research/auth.ts`). Account creation stays disabled.

Fixed ids from later-0023: bundle id `now.notfor.later`, app group `group.now.notfor.later`,
URL scheme `later`. Configuration values `SUPABASE_URL`, `SUPABASE_ANON_KEY` (both
browser-safe public values, the same as the web's `NEXT_PUBLIC_*`) and `LATER_API_BASE_URL`
(`https://notfor.now`) come from xcconfig.

## Scope

**Does**
- Add `supabase-swift` (Swift Package, exact pinned version) to the **app target only** (LaterKit
  stays Foundation-only and Linux-buildable).
- Config: `ios/Config/Secrets.example.xcconfig` (committed, placeholder values) and a gitignored
  `ios/Config/Secrets.xcconfig`; build fails with a clear message in Release if values are
  placeholders. CI/simulator tests use placeholders and never reach the network.
- Sign-in screen (shown when signed out, in place of the "not connected yet" states from 0023):
  email field → `signInWithOTP(email:, redirectTo: later://auth-callback, shouldCreateUser: false)`
  → "Check your email" state; the app handles `later://auth-callback` via `onOpenURL` and completes
  the session (PKCE). Errors show one generic message (no account enumeration).
- Session storage in the Keychain, access group shared with the future share extension
  (`$(AppIdentifierPrefix)now.notfor.later.shared`), accessibility
  `afterFirstUnlockThisDeviceOnly` so background audio/Siri can work while locked. Simulator builds
  without signing must still run (fall back to the default group only when unsigned, in Debug).
- LaterKit `API/`: a `LaterAPIClient` protocol + Foundation implementation that attaches the
  bearer token from an injected `TokenProvider`, refreshes once on 401 and retries once, then
  reports `sessionEnded`; decodes `{"error": …}` bodies. Uses `URLSession` (FoundationNetworking on
  Linux).
- Signed-in shell: Listen/Saved still show an honest "nothing to show yet" state until later tasks
  connect data; Settings/About shows the signed-in email and **Sign out** (clears Keychain session
  and all cached user data directories created by the app).
- `ios/README.md`: the one human setup step — add `later://auth-callback` to Supabase Auth →
  Redirect URLs — and how to provide `Secrets.xcconfig` locally.

**Does not**
- Call library/narration endpoints (later-0029+). Create accounts. Store the email anywhere but
  the Supabase session. Touch `src/` or Supabase config.

## Acceptance criteria

- [ ] Given signed out, when the app launches, then the sign-in screen shows and no tab content —
      `LaterAppUITests/AuthUITests.testSignedOutShowsSignIn` (stubbed auth).
- [ ] Given an email submitted, then the OTP request uses `shouldCreateUser: false` and redirect
      `later://auth-callback` — `LaterAppTests/AuthServiceTests.testMagicLinkRequestShape`.
- [ ] Given the callback URL, then the session completes and the signed-in shell appears; given a
      malformed/foreign URL, nothing happens — `AuthServiceTests`.
- [ ] Given a request that returns 401, then the client refreshes once and retries once; a second
      401 yields `sessionEnded` — `LaterKitTests/API/LaterAPIClientTests` (runs on Linux and macOS).
- [ ] Given sign out, then the Keychain session and the app's cached-data directories are removed
      — `AuthServiceTests.testSignOutClearsSessionAndCaches`.
- [ ] Given the Keychain item, then its accessibility is after-first-unlock-this-device-only —
      `LaterAppTests/KeychainTests`.
- [ ] `ios-ci` and the Flow `ios/` source-root check pass with coverage floors met.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Real sign-in can only be exercised on a signed build after the Supabase redirect URL is added;
  that is verified in later-0036, not here.
