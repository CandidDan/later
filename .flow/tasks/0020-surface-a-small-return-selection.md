---
id: "later-0020"
title: "Add a private page for coming back to saved items"
status: "in_progress"
priority: 3
project: "later"
owner: "codex-cloud-2be27cbbae31"
created: "2026-10-05"
started: "2026-10-06T23:41:57Z"
branch: "flow/later-0020-private-return"
pr: "https://github.com/CandidDan/later/pull/38"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G2", "G3"]
touches: ["src/app/revisit/**", "src/app/page.tsx", "src/lib/revisit/**", "src/app/research/auth.ts", "src/app/research/auth.test.ts", "README.md", "src/lib/operations/**"]
labels: ["revisit", "capture"]
asks: ["fyi: PR #38 implements the private return page. Before a later launch, add the exact https://notfor.now/revisit redirect (and approved deployment equivalents) in Supabase Auth; no live configuration was changed."]
notes: ["Approved direction: make daily saves recognisable, then provide a small return surface; keep research separate.","2026-10-07: Human requested the next implementation session in the cloud and approved touches widening. later-0018 PR #31 and later-0019 PR #37 have merged. Task unblocked; src/lib/operations/** added for return-route/auth launch contract and proving tests. Keep original acceptance criteria. Do not start Docker or run resource-heavy database tests on the human workstation; use a disposable cloud environment and hosted CI for full database proof. Existing default pnpm test/test:coverage on main already executes real database tests on the GitHub hosted runner; no skips or mocked replacement proofs are approved.","2026-10-07 cloud handoff: Implemented only later-0020 on flow/later-0020-private-return, PR https://github.com/CandidDan/later/pull/38, final feature head e3293131130da375bce75232cacb18b9205359c0. Direct /revisit magic-link return, bounded shared cards, persisted Open/defer/consume, idempotent retries, session/asset recovery, focus and separate research navigation are complete. Main claim used an expected-head GitHub ref update because shell pushes lack credentials; no human workstation resources used. Cloud container has no Docker, so preserved full tests and proved real disposable PostgreSQL, 45 pgTAP outcomes, concurrency orders and controller reload on GitHub Actions run 37549494544: build/lint/test/coverage/scope/store gates pass, 582 tests pass, line coverage 84.56% against 15% floor. Three pre-existing optional live private-media tests remain unchanged; no database proof was skipped. Cloud Chromium browser-proof.test.mjs passes sent link, preview retry, 320px overflow, keyboard/focus, failure/retry, explicit more, reload and expiry. Two existing canonical Flow lint warnings remain; canonical infrastructure untouched. No deployment, merge or live configuration edits. Next: mark PR #38 ready (worker final step), then inspect independent QA/code-review/security checks and review the PR; address any kickback in a fresh session on this same branch. README records the exact /revisit redirect required before a later launch."]
---

## Context

The user wants to come back to genuine daily captures without first filling out a research questionnaire. later-0018 supplies recognisable cards; later-0019 supplies bounded selection, durable actions and exposure protection. Build the usable return page on those contracts. This is a pull-based pilot of VISION G2/G3, using the user's own saves, with no recommendation model or playback.

## Scope

- Add private `/revisit` and make it the clear entry from the landing page, with a separate link to `/research`. Reuse the authorized v0 account and magic-link flow; allow the callback to return to `/revisit` without redirecting through a rich research reveal. Document the additional exact Supabase redirect URL in README; no live configuration edits.
- On sign-in show up to three cards, headed “Come back to this”, using the shared card's trusted title/source, original note, attachment preview and readable save date. No raw JSON or technical pipeline information in this experience.
- Offer Open original, Another time and Already consumed through the persisted API. Explain Another time's seven-day delay near the action. Open navigates only after its event persists and does not mark consumption; keep the item available until an explicit choice. Disable Open when no destination exists; stored attachment actions remain available.
- After deferral/consumption remove the affected card and offer “Show a few more” to request another bounded batch. Do not automatically load replacements or expose an endless archive. Empty copy is “Nothing to bring back right now.” No count of total saves, streaks or overdue language.
- Include loading, sign-in, magic-link sent, expired-session and recoverable API/asset error states. Keep a failed action's card and choices visible, avoid duplicate submissions and communicate when an action has not saved.
- Keep research's recall prompt separate. No model interest summaries, reminders, ranking controls, consumption inference, player, global CSS redesign or live deployment.

## Acceptance criteria

- [ ] Given the authorized user signs in from `/revisit`, when the magic-link session completes, then the return page loads its bounded authenticated selection directly; signed-out/wrong-user sessions show no captured content and expiry clears visible private data.
- [ ] Given older link, email, image and incomplete-enrichment fixtures, when the page renders, then recognisable shared cards and original context appear without JSON, backlog totals or mandatory research forms.
- [ ] Given Open original succeeds or fails to persist, when activated, then successful requests navigate to the returned safe destination without marking consumed, while failed requests keep the card visible and provide a retry; missing destinations disable Open.
- [ ] Given Another time or Already consumed succeeds, when the UI updates and the page is reloaded, then the affected card stays absent according to stored state and no replacement appears until Show a few more is activated.
- [ ] Given empty, loading, preview-failure and API-failure responses, when displayed, then each has the specified understandable state and available recovery without discarding unsaved choices.
- [ ] Given keyboard navigation and narrow-screen rendering, when the user operates the page, then card actions and auth forms are labelled, focus remains usable after card removal, pending/status updates are announced and long content does not cause horizontal overflow.
- [ ] Given the landing page and launch documentation, when inspected in tests, then `/revisit` and separate `/research` navigation exist and the exact `/revisit` auth redirect requirement is documented.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Tests use mocked providers and synthetic captures. Opening is an attempt, not evidence of consumption; Already consumed is explicitly self-reported. The pilot needs no vision amendment: it exercises the existing return/consumption goals without recommendations or AI substitutes.
