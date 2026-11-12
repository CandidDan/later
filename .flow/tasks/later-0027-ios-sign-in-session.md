---
id: "later-0027"
title: "Sign in to Later on iPhone with a magic link and keep the session safely"
status: "in_review"
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
  - "2026-11-12 15:43 UTC kickback coordination: full final-head Flow gate 43238839152 and source-root passed on c7fa61d, alongside macOS, QA and security; code-review 43238839333 fails on treating 408/429 as rejected credentials. Existing branch has no newer commits or active implementation handoff. Continuing only this review fix on same PR: restrict token-endpoint session termination to 400/401/403 and missing session, add real SDK 408/429 preservation/retry cases with realistic error codes, retain rejected-token tests. No merge until fresh final-head gates and independent review pass. Existing task owner/status retained."
  - "2026-11-12 14:36 UTC ready handoff: existing PR #61 marked ready at unchanged c7fa61d1ec34a7b4339de8dd078dc2e44729b88e to execute hosted validation under the recorded CI sequencing decision. Confirmed full Flow run https://github.com/CandidDan/later/actions/runs/43238839152 and independent review run https://github.com/CandidDan/later/actions/runs/43238839333 are actually in progress, not skipped. PR description now cites exact-head macOS run 43221157648 (32 unit + 5 UI passing, 92.23% app coverage) and explicitly marks full Linux proof pending instead of reusing earlier-head green results. No new code, merge or deployment in this pass. Next fresh verification session: inspect both runs and QA/code/security findings on c7fa61d, address blocking failures on existing branch if needed, verify unchanged head and all required checks before merging, then let flow-done/flow-unblock release Saved 0029 and share extension 0034. Do not duplicate active workers. Apple signing remains unverified and later release work."
  - "2026-11-12 14:35 UTC CI orchestration decision under Dan's explicit CI delegation: verified c7fa61d1ec34a7b4339de8dd078dc2e44729b88e hosted macOS run 43221157648 passed 32 app tests and 5 UI tests, 92.23% app coverage against 40% floor. Full Linux gate and reviews are skipped solely because PR is draft; available connector lacks workflow_dispatch. Authorize ready_for_review as the supported hosted Actions trigger to obtain the full gate, overriding only pre-ready sequencing for this run. This is not certification or permission to merge red/unrun checks; retain every database/browser/coverage/review gate, require all on final head before merge, and leave downstream tasks blocked. No worker edits are in flight in current handoff, branch unchanged since prior repair. Next: mark existing PR #61 ready, inspect complete hosted gate and reviewer outcomes, fix genuine failures on same branch, then merge only if final-head checks and reviewer findings pass."
  - "2026-11-12 continuation repair handoff: pushed c7fa61d1ec34a7b4339de8dd078dc2e44729b88e to existing flow/later-0027-ios-sign-in / draft PR #61. Changed only two AuthServiceTests assertions: unwrap durable stored data, decode Session with JSONDecoder and compare all values to saved; retained in-memory session equality, actual cached-file content, clear-count, no-network restore, transient error and successful retry checks. Published source fetched and verified byte-for-byte against intended edit. This fixes the observed raw-JSON identity test mismatch without loosening session preservation behavior. Hosted macOS ios-ci run 43221157648 is in progress on this exact head; no passing test result claimed. Draft-triggered full Flow gates/reviews are skipped, not green; complete Linux database/browser proof still needs hosted execution before ready handoff. No local Docker, auth config changes, merge or new task claim. Next: inspect 43221157648; repair genuine failures on this branch, obtain full Actions Linux gates, update PR proof, mark ready for independent QA/security/code review and merge only once final-head required checks and findings are clear. Coordinate with existing gate monitor before editing."
  - "2026-11-12 continuation takes the narrowly scoped completed-worker test follow-up on existing PR #61, without changing task ownership: hosted ios-ci 43219180854 finished failing at acb7cfbc. All five UI tests pass; seven assertions across two AuthServiceTests fail only on raw stored Data equality (333/334 bytes vs 375/376). Session equality, cache retention, no clearing and retry assertions passed. Next change is to assert decoded durable Session equality instead of JSON byte identity, preserving all behavioral assertions; SDK storage serialization is not the product contract. Recheck head before write and rerun hosted macOS; full Linux gate and independent review remain required."
  - "2026-11-12 auth recovery implementation handoff: PR #61 remains draft at acb7cfbc52aa5986759076c51aacf2b2e0e347c2, clean worktree later-signin aligned to remote. Fix and real-SDK/LaterKit regression coverage are pushed (see preceding note and PR checklist). Exact-head Linux iOS check passes 37 tests, 96.74% coverage and 20 scripts. Pinned pnpm 11.19.0 installed in cloud; production build and lint pass with 4 existing Flow warnings. Full test and test:coverage each report 800 passing tests, but 3 required database suites fail because Docker is absent; browser stage never reached. Do not count this as a full gate pass. Hosted macOS ios-ci 43219180854 still runs; gate monitor owns observation. MacBookPro.lan is offline, cloud gh unauthenticated, connector has no workflow dispatch, and cloud GitHub browser is signed out. No readiness change or merge until full proof passes. Cloud rootless Docker remains a possible next route: user namespaces work, but Docker/socket/rootlesskit/newuidmap/newgidmap are absent and process has no capabilities. Parent authorizes investigation from official sources without security setting changes; no container software was installed. Exact next: finish hosted iOS observation, fix any compile/test failure in a fresh session, obtain unchanged full gate proof using authorized cloud Docker or hosted dispatch, replace stale PR run links, mark ready and let independent reviews run. Never weaken or skip database tests. Notes/task status on main preserved; no new claim."
  - "2026-11-12 auth recovery kickback: PR #61 is draft at acb7cfbc52aa5986759076c51aacf2b2e0e347c2. Startup restores durable local identity without network refresh; AuthService preserves sessions/cache for transport and server failures, clearing only missing or rejected credentials. LaterKit refresh now propagates transient errors instead of invoking sessionEnded. Real SDK regression tests cover offline expired-session restore, offline/timeout/503 token failures and successful retry, rejected 400/401/403 refresh, and missing session; Linux regression covers offline refresh after API 401. Linux check passed 37 Swift tests, 96.74% coverage and 20 script tests. Hosted ios-ci 43219180854 is pending; full Flow dispatch is being coordinated. Next: inspect exact-head macOS build/test/coverage and full Flow gates, fix failures if any, update PR proof, and mark ready for independent review. No merge until all reviewers pass. Nonblocking busy signOut race remains; no new task claim or auth configuration change."
  - "2026-11-12 review coordination: Confirmed exact-head Flow QA/security success and code-review failure on 67e859c; no unresolved inline threads. The blocking offline-session/cache deletion finding is accepted and a fresh kickback implementation session owns the existing branch, so this review session made no code changes and did not merge. Next review must inspect the newly pushed head, its offline restore/refresh regressions and session-ended concurrency behavior, then require fresh hosted macOS ios-ci, full Flow gates, and independent QA/security/code-review success before merging. Keep downstream tasks blocked until flow-done records this task done. The three low security notes do not block this head: custom URL scheme is PKCE-protected, non-Release custom build configs still have runtime key validation, and test auth is Debug simulator-only."
  - "2026-11-12 continuation review: PR #61 head 67e859c3521f8f0cc335a40de1d0e0c8d64e3f19 has QA PASS, security PASS and hosted ios-ci success, but independent code-review FAIL (https://github.com/CandidDan/later/pull/61#issuecomment-6823635041). Blocking finding: AuthService.restore() and token(refresh:) treat transient offline/timeout/5xx failures as session termination and delete Keychain/cached user data, defeating offline playback. No merge attempted and no worker branch overwritten; existing owner preserved. Exact next action on existing flow/later-0027-ios-sign-in: distinguish rejected/missing/revoked auth from transient transport/server failures, retain stored session and caches on transient failures, add offline restore and offline refresh regressions, then rerun hosted macOS ios-ci, Linux full gates and independent reviews on the final head. Inspect concurrent branch/task updates before editing. Also consider the nonblocking busy signOut/sessionEnded race and cite the separate Keychain cleanup test in the PR checklist. Tasks 0029 and 0034 remain dependency-blocked until this PR passes and merges; do not duplicate them or release early. Apple signing is not yet the only remaining blocker. No implementation or new test execution occurred in this review pass."
  - "2026-11-12: Completed the verification handoff for PR #61 and marked it ready for review at exact head 67e859c3521f8f0cc335a40de1d0e0c8d64e3f19. Rebased onto merged task 0028, preserving all TimeFit additions. Final hosted ios-ci https://github.com/CandidDan/later/actions/runs/43216324990 passed 28 unit tests and 5 UI tests, zero failures, 91.48% app line coverage; final full Flow gates https://github.com/CandidDan/later/actions/runs/43216447557 passed all three jobs. Combined Linux check passed 36 Swift tests with 96.74% LaterKit coverage and 20 script tests. Simulator screenshot was exported and visually checked; final Later-xcresult artifact 13943214739 contains captures. PR body now maps all acceptance criteria to passing tests. Independent Flow QA, code-review and security checks were triggered by ready_for_review and are still pending; do not merge until all required checks pass. Next session: read those exact-head review results, address any blocking finding on this branch, and rerun affected gates. No real login or hosted authentication settings were changed; signed-device verification remains task 0036. Worktree later-signin is clean and aligned to the remote head. This session ends at the ready handoff under Flow."
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
