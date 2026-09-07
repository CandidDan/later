---
id: "later-0006"
title: "Process pending intent jobs automatically"
status: "done"
priority: 3
project: "later"
owner: "codex-01a076ff-34b2-79b1-b891-59f8f632bd0b"
created: "2026-09-06"
started: "2026-09-07T04:50:39Z"
branch: "codex/later-0006-automatic-processing"
pr: "https://github.com/CandidDan/later/pull/8"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: ["README.md", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**", "supabase/migrations/*schedule_intent_processing.sql", "supabase/tests/database/*schedule_intent_processing.test.sql"]
labels: ["intent", "jobs", "operations"]
notes: ["Depends only on the completed later-0005 pipeline. Use Supabase Cron plus pg_net to POST the existing Vercel job endpoint once per minute, with the URL and JOBS_PROCESS_SECRET read by name from Supabase Vault rather than embedded in migrations. This avoids depending on Vercel Pro cron frequency. Official references: https://supabase.com/docs/guides/cron and https://supabase.com/docs/guides/database/extensions/pg_net.", "2026-09-07 review handoff: Implementation complete on codex/later-0006-automatic-processing at 96380e4, PR https://github.com/CandidDan/later/pull/8. Local build/lint/test/coverage gates pass: 96 application tests, 90.8% line coverage, zero lint errors and three pre-existing canonical Flow warnings. Two clean isolated Supabase rebuilds each passed 101 database assertions, including independent-connection claim/finalization races and rollback after interrupted completion. QA/security/code-review workflows are running on the PR; their verdicts are not self-certified. Scope is unchanged and no live deployment was performed. Temporary session handoff notes were removed as requested. Next action: human reviews PR and its CI verdicts; any kickback is addressed in a fresh worker session on the same branch. Do not merge or deploy without user authorization."]
---

## Context

Later now persists an `intent_analysis` job and has a protected route that can process it, but nothing invokes that route automatically. A real capture would therefore remain pending until an operator manually calls the endpoint. Intent must begin soon after capture while remaining completely outside the acknowledgement request. The retry lifecycle must also prevent one failing job from being reclaimed repeatedly in the same drain or remaining stranded forever after a worker interruption.

## Scope

- Add a versioned Supabase Cron/pg_net schedule that invokes `POST /api/jobs/process` once per minute.
- Resolve the production endpoint URL and bearer secret from named Supabase Vault entries at execution time. Never place either secret value in a migration, cron command text, response, test fixture that resembles a real secret, or log.
- Preserve the existing fail-closed endpoint and bounded batch behavior.
- Make failed attempts eligible only after an increasing retry delay, and move a job to terminal `failed` after three attempts instead of immediately reclaiming it in the same batch forever.
- Recover a `processing` job whose lease has been stale for ten minutes while leaving a live lease untouched.
- Keep claiming concurrency-safe so overlapping scheduler invocations cannot produce duplicate successful analysis runs for one job.
- Add concise README operator documentation for creating the two Vault entries, applying the schedule, verifying a run, and safely invoking the endpoint manually.
- Do not call the model from the WhatsApp request, change the acknowledgement, add new capture channels, process source-resolution jobs, or expose analysis results.

## Acceptance criteria

- [ ] Given a pending intent job and configured Vault entries, when the one-minute schedule fires, then it sends an authenticated POST to the configured production endpoint and the job can complete without an inbound capture request remaining open.
- [ ] Given either Vault entry is absent or the presented bearer token is wrong, when dispatch is attempted, then no unauthenticated processing occurs, the route fails closed, and no secret value appears in persisted scheduler text, output or logs.
- [ ] Given an intent attempt fails, when the same batch continues, then that job is not reclaimed before its future `available_at`; after its third failed attempt it becomes terminal `failed` with only a safe error code/detail recorded.
- [ ] Given a job has remained `processing` with a lease older than ten minutes, when the next claim cycle runs, then the stale job becomes eligible for one retry; a job with a newer lease remains unavailable.
- [ ] Given two scheduler calls overlap, when both try to claim the same pending job, then at most one call owns it and at most one successful analysis is appended for that job.
- [ ] Given a fresh operator, when they follow the README's intent-processing section, then every required Vault name, environment variable, verification query and manual recovery call is identified without including a credential value.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The one-minute schedule is intentionally simple polling over the durable database queue. Event infrastructure or a second queue product would add operational complexity before the single-user experiment needs it. The manual endpoint remains useful for smoke tests and recovery.
