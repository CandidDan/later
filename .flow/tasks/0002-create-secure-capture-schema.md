---
id: "later-0002"
title: "Create the secure Supabase capture schema"
status: "done"
priority: 3
project: "later"
owner: "codex-later-0002-01a0628b"
created: "2026-09-02"
started: "2026-09-02T14:36:51Z"
branch: "flow/later-0002-secure-supabase-schema"
pr: "https://github.com/CandidDan/later/pull/4"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: ["supabase/**"]
labels: ["database", "security"]
notes:
  - "The new supabase/ tree is intentional greenfield infrastructure from Phase 1 of the approved v0 build order."
  - "Handoff 2026-09-02: Implemented the secure schema, private bucket, RLS policies, and 42-assertion database suite on flow/later-0002-secure-supabase-schema in PR #4. Two clean local migration applications passed 42/42 each; hosted build, scope, QA, security, and code-review checks are green. Provider idempotency is scoped by user to prevent cross-tenant suppression. Nothing only appears done. Next action: human reviews and merges PR #4; do not modify or merge from a worker session."
---

## Context

Later must retain captures losslessly while treating forwarded messages, emails and media as potentially private. The approved v0 model separates captures, original assets, immutable analysis runs and independently measurable processing jobs. This task establishes that secure data plane as versioned Supabase migrations before application persistence is wired to it.

## Scope

- Add a Supabase project configuration and versioned migrations for `captures`, `capture_assets`, `capture_analyses` and `capture_jobs`.
- Include foreign keys, deletion behavior, timestamps, useful status/type constraints, uniqueness needed for provider idempotency, and indexes for chronological capture and pending-job lookup.
- Create a private capture-assets Storage bucket with paths scoped as `captures/{user_id}/{capture_id}/{filename}`.
- Enable RLS on every table. Authenticated users may read and permanently delete only captures they own and may read their related assets, analyses and jobs; provider ingestion and processing writes remain service-role-only.
- Keep capture analyses append-only through the ordinary authenticated path so a later run cannot overwrite experimental history.
- Add database-level verification that applies the migrations and exercises ownership isolation, bucket privacy, idempotency constraints and append-only behavior against a disposable test database or equivalent migration test harness.
- Do not add application clients, environment files, persistence functions, webhooks, provider SDKs, model calls, routes or UI.

## Acceptance criteria

- [ ] Given a clean database, when the migrations are applied, then all four v0 tables exist with their declared relationships, constraints and indexes, and the capture-assets bucket exists as private.
- [ ] Given the same non-empty capture channel and external message id twice, when both records are inserted, then the database prevents two distinct captures while still permitting records whose external message id is absent.
- [ ] Given two authenticated users, when each queries or deletes through RLS, then neither can read or delete the other's captures or related records, while each can permanently delete their own capture and its dependent data.
- [ ] Given an authenticated user rather than the service role, when they try to insert or mutate analyses and processing jobs, then the database denies the write; existing analysis rows remain append-only through that path.
- [ ] Given an asset path owned by another user or an unsigned public request, when Storage access is attempted, then the object is not readable; the owning user can access only objects under their own capture path.
- [ ] Given the full migration set is applied twice in the supported migration workflow, when verification runs, then the resulting schema is consistent and no partially configured public bucket or table is created.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

This is the deliberate Phase 1 greenfield database subsystem. Keep provider-specific payloads in JSON rather than creating channel-specific tables, and avoid schema for recommendations, resurfacing, playback or multi-user collaboration.
