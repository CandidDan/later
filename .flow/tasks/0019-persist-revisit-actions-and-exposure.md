---
id: "later-0019"
title: "Persist revisit choices and protect unaided recall"
status: "ready"
priority: 3
project: "later"
owner: ""
created: "2026-10-05"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G2", "G3"]
touches: ["src/lib/revisit/**", "src/app/api/revisit/**", "src/lib/research/**", "supabase/migrations/*_capture_revisit_state.sql", "supabase/tests/database/capture_revisit_state.test.sql"]
labels: ["revisit", "capture"]
notes: ["2026-10-06: Human-authorized dependency reconciliation: latest origin/main c2d7680 confirms later-0018 done after PR #31 merged; sole block cleared, approved spec unchanged.", "Approved direction: make daily saves recognisable, then provide a small return surface; keep research separate."]
---

## Context

The return page must offer a few actionable saves rather than an accumulating obligation. Its choices must survive refresh and device changes. Rich cards can also remind the user of an item before research asks for unaided recall; record that exposure honestly instead of silently contaminating the experiment. Uses the card contract from later-0018 and provides the server contract for later-0020.

## Scope

- Add a forward migration for owner-scoped revisit state/events with RLS and owned-capture referential integrity. Record first exposure, open attempts, deferred-until and explicit consumed-at with server timestamps. Preserve capture evidence and frozen analyses unchanged.
- Provide an authenticated batch endpoint returning at most three eligible captures, oldest saved first (ID tie-break), excluding explicitly consumed captures and those deferred into the future. Include captures without successful analyses. Repeated requests are deterministic when state/time have not changed; no archive count or endless pagination.
- Persist exposure for every card released in a successful batch response before returning rich content. Also record exposure before a single-card endpoint returns rich content; direct card/asset access must not bypass this boundary. Asset access records exposure before releasing bytes. This measures content released by Later, not proof the user saw it.
- Provide idempotent actions keyed by a client request ID: Open records an open attempt and returns a safe destination; Another time defers seven days from server time; Already consumed records the user's explicit report. No destination means Open is unavailable. An open attempt never sets consumed-at. Invalid/foreign IDs and actions fail closed.
- Update research selection and recall-write enforcement so previously exposed captures without persisted recall are excluded from fresh unaided recall. Existing persisted recall can still resume and be rated. Serialize exposure and fresh recall writes per owned capture so a concurrent/stale recall submission cannot enter after exposure; check in the database, not just the UI.
- No recommendations, AI ranking, scheduled notifications, automatic consumption claims, task backlog totals, auth expansion, provider fetching, deployment or production migrations. Existing research results remain untouched.

## Acceptance criteria

- [ ] Given eligible, deferred, consumed and unanalysed captures, when batches are requested with a controlled clock, then at most three eligible cards appear in oldest-first stable order; deferred items return after seven days and consumed items remain absent after reload.
- [ ] Given batch, single-card and asset requests, when rich data/bytes are released, then durable first exposure exists before release; repeated requests preserve the original first-exposure timestamp and rejected requests expose no content.
- [ ] Given repeated Open, Another time and Already consumed request IDs, when actions are retried, then each applies once, deferral does not move on retry and only Already consumed marks consumption; Open returns only a validated available destination.
- [ ] Given an exposed capture without recall, when research selects its next capture or a stale client submits recall, then fresh unaided recall is refused; an existing persisted recall still resumes, and previously stored evaluations remain identical.
- [ ] Given exposure and fresh recall requests racing in either order, when their transactions complete, then fresh recall is accepted only if durably stored before exposure, with no partial multi-run recall rows.
- [ ] Given anonymous or different-owner reads/writes including direct database access, when operations run, then RLS and ownership checks prevent reading or mutating another user's state/captures; invalid IDs/actions cannot write events.
- [ ] Given an empty batch, a persistence failure or unavailable source destination, when endpoints respond, then they return a bounded explicit empty/error/unavailable outcome without fabricated success or capture/credential logging.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Priority remains the default 3. Seven-day deferral is a fixed v1 implementation choice, not an inferred preference. Exposure is conservatively recorded on release, including failed client rendering; no historical exposure is guessed or backfilled. Use the migration rerun checks and database concurrency tests alongside handler/store tests.
