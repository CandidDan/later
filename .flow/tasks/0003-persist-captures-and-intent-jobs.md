---
id: "later-0003"
title: "Persist captures and enqueue intent work atomically"
status: "done"
priority: 3
project: "later"
owner: "codex-later-0003-01a064e0"
created: "2026-09-02"
started: "2026-09-03T01:28:51Z"
branch: "flow/later-0003-persist-captures-and-intent-work"
pr: "https://github.com/CandidDan/later/pull/5"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "package.json", "pnpm-lock.yaml", "supabase/**", "src/lib/capture/**", "src/lib/jobs/**", "src/lib/supabase/**"]
labels: ["capture", "database"]
notes:
  - "Depends on later-0001 and later-0002 so persistence consumes the normalized capture contract and migrated schema."
  - "Worker handoff 2026-09-03: Genuinely done on flow/later-0003-persist-captures-and-intent-work in PR https://github.com/CandidDan/later/pull/5: server-only Supabase client, narrow provider-neutral persistence API, transactional capture/assets/intent-job RPC, idempotent provider retry handling, distinct no-external-id captures, and all AC1-AC6 proving tests. Local build passed; lint passed with zero errors and three pre-existing Flow-tool warnings; 21/21 Vitest tests passed; coverage was 81.69% lines against the 15% floor; both clean Supabase resets passed all 60 pgTAP assertions. Hosted gate, touches, tooling, QA, security, code-review, status, planning, and PR automation checks are green. The QA kickback was resolved by making the configured AC2 test stage capture and asset mutations before an injected job failure and assert transaction discard. Decisions: keep privileged client construction behind server-only boundaries; expose only the RPC-shaped adapter surface; persist original asset JSON unchanged in metadata while deriving deterministic private storage paths; accept normalized link kind without removing the existing url value. Nothing only looks done. Not done: human validation and merge. Next action: review PR #5 and merge it if accepted; flow-done will mark the task done."
---

## Context

Later's critical path is validate, persist the raw capture, queue processing, then acknowledge. AI and external-site work must remain outside that path. With the normalized capture contract and secure database schema in place, channel adapters need one server-only operation that makes durable capture plus initial processing work a single reliable boundary.

## Scope

- Add a server-only Supabase client whose required environment variables are documented in `.env.example` and whose service-role secret cannot enter client bundles.
- Implement one persistence operation that stores a normalized capture, optional asset metadata and its initial pending `intent_analysis` job as one atomic database operation.
- Add any follow-up migration required for the atomic database function while preserving the schema and policies established by later-0002.
- Make ingestion idempotent for a non-empty `(capture_channel, external_message_id)` pair so provider retries return the original capture without creating another intent job.
- Preserve `raw_payload` and original capture fields without model-derived enrichment.
- Expose narrow application types/results for later channel adapters rather than leaking the raw service-role client.
- Do not add channel webhooks, media downloads, model calls, source/segment resolution, the research console or evaluation UX.

## Acceptance criteria

- [ ] Given a normalized capture with asset metadata, when the server persistence operation succeeds, then the capture, assets and exactly one pending `intent_analysis` job are committed together with the raw payload deeply unchanged.
- [ ] Given a failure while creating the initial intent job, when the atomic persistence operation aborts, then no partial capture or asset record is committed.
- [ ] Given the same non-empty channel and external message id twice, when persistence is called twice, then both calls resolve to the same capture and only one initial intent job exists.
- [ ] Given captures without an external message id, when separate persistence calls are made, then each call creates its own capture and pending intent job rather than deduplicating unrelated user actions.
- [ ] Given a production build, when client-reachable modules are traversed through the project's proving test, then neither the Supabase service-role value nor the privileged client is exposed.
- [ ] Given provider-neutral input from later-0001, when it is passed to persistence, then no provider-specific adapter type or model-derived field is required to store it.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

No hosted credentials are required to complete the task. Use test doubles or a disposable local Supabase instance as appropriate, but the proving tests must exercise commit, rollback and idempotency outcomes rather than merely snapshotting SQL text.
