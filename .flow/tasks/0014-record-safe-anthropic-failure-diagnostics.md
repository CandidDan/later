---
id: "later-0014"
title: "Record safe Anthropic failure diagnostics"
status: "in_progress"
priority: 3
project: "later"
owner: "claude-worker-later-0014"
created: "2026-09-24"
started: "2026-09-24T07:14:23Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["maintenance"]
touches: ["src/lib/processing/**"]
labels: ["observability", "anthropic", "intent", "production"]
notes:
  - date: "2026-09-24"
    by: "claude-worker-later-0014"
    text: >
      Implementation and gate complete on branch flow/later-0014-safe-anthropic-failure-diagnostics
      (pushed). New src/lib/processing/failure-diagnostics.ts derives an allowlisted
      intent_provider_failure event (category, retryable, numeric status, validated req_ id,
      operation, jobId, captureId); intent.ts emits exactly one per failed analyse() attempt via an
      injectable sink defaulting to console.error(JSON.stringify(event)). Stored error codes are
      now derived from the category through failureErrorCode(), which reproduces the previous
      classifyFailure() mapping exactly, so the three durable codes and the SQL attempts>=3 retry
      schedule are unchanged. Gate green locally - build, lint (0 errors, 3 pre-existing warnings in
      .flow/bin), 441 tests pass, coverage 80.47% vs floor 15. Note pnpm build must run before
      pnpm test or src/lib/supabase/server.test.ts fails on a missing .next/static (pre-existing).
      Next action - open the PR titled "[later-0014] Record safe Anthropic failure diagnostics".
  - date: "2026-09-24"
    by: "claude-worker-later-0014"
    text: >
      DONE except the PR itself. Branch flow/later-0014-safe-anthropic-failure-diagnostics is
      pushed at 259e627, rebased on main, gate green (build, lint 0 errors, 441 tests, coverage
      80.47% vs floor 15), diff confined to src/lib/processing/** and touching no .flow/tasks file.
      The worker could not open the PR - this session runs inside GitHub Actions with the ephemeral
      GITHUB_TOKEN, and the repo/org setting "Allow GitHub Actions to create and approve pull
      requests" is off, so both `gh pr create` and POST /repos/CandidDan/later/pulls return
      403 "GitHub Actions is not permitted to create or approve pull requests". flow-open-pr did
      not cover for it either, because a push made with GITHUB_TOKEN does not trigger further
      workflow runs, so no `push` event fired for this branch. Not a code or scope problem, and not
      a decision anyone needs to make - it is a missing credential.
      EXACT NEXT ACTION - someone with repo credentials (or flow-recover, which carries FLOW_PAT
      and sweeps every 3h) opens the PR - `gh pr create --base main --head
      flow/later-0014-safe-anthropic-failure-diagnostics --title "[later-0014] Record safe
      Anthropic failure diagnostics"`. The `[later-0014]` title prefix is what flow-status and
      flow-done read, so it must be exact. Then `gh pr ready` for the hand-off to in_review.
      Criterion-to-test mapping for the PR body - AC1 intent.test.ts "later-0014 failure
      diagnostics > AC1 emits exactly one diagnostic for %s" (6 categories) plus "AC1 names the
      enriched operation", and failure-diagnostics.test.ts "AC1 categorises %s"; AC2
      failure-diagnostics.test.ts "AC2 includes a request id that matches the provider's documented
      shape" / "AC2 omits an %s request id rather than copying it" (7 shapes) and the two
      intent.test.ts AC2 cases; AC3 failure-diagnostics.test.ts "AC3 emits none of the error's
      message, name, stack, cause, headers or bodies" and intent.test.ts "AC3 emits no provider
      text, credential or captured content anywhere in the event"; AC4 failure-diagnostics.test.ts
      "AC4 describes %s as a bounded unknown failure" (7 values), "AC4 survives a value whose every
      property getter throws", "AC4 never turns a logging failure into a second thrown error", and
      intent.test.ts "AC4 finishes the attempt normally when the diagnostic sink itself throws";
      AC5 intent.test.ts "AC5 leaves the stored code, analysis record and retry hand-back unchanged
      for %s", which drives three consecutive attempts per failure kind and asserts attempts 1/2/3
      reach finishAttempt with the unchanged code.
---

## Context

Later's first production intent job still exhausted its three retries after the structured-output
schema fix in `later-0013`. Each attempt was stored as `provider_unavailable` without a model id.
The Vercel deployment has non-empty Anthropic configuration metadata and the Anthropic account is
successfully serving other Haiku and Sonnet requests, but Later deliberately discards raw provider
errors. That privacy boundary is correct; the absence of a safe diagnostic now prevents operations
from distinguishing authentication, permission/model access, rate limiting, provider 5xx, timeout,
network and unknown failures.

This task adds bounded operational evidence without weakening the rule that provider-controlled
text and private capture content must never enter logs or the database.

## Scope

- Emit one structured diagnostic event when an intent-analysis attempt fails at the Anthropic
  boundary.
- Derive every diagnostic field through an allowlisted, bounded mapping. Include only the provider,
  operation, internal job and capture ids, a safe failure category, numeric HTTP status when
  available, a validated provider request id when available, and whether the category is retryable.
- Keep unknown or malformed errors diagnosable through an `unknown` category without serialising
  the error object.
- Preserve the existing database error codes, retry schedule, analysis records and HTTP behaviour.
- Add tests proving both the useful diagnostic fields and the privacy boundary.
- Do not log raw error messages, names, stacks, causes, headers, request or response bodies, API
  keys, prompts, model output, captured text, URLs, media or other provider-controlled values.
- Do not change model selection, prompts, schemas, environment variables, database schema,
  resolution pipelines or production data.
- Do not deploy or retry the failed production capture from the worker; those are post-merge
  operational verification steps.

## Acceptance criteria

- [ ] Given an Anthropic authentication, permission/model-access, rate-limit, provider-server,
  timeout or network failure, when the intent attempt is recorded as failed, then exactly one
  structured diagnostic is emitted with the correct allowlisted category, numeric status when
  available, retryability, provider and operation, plus the internal job and capture ids.
- [ ] Given a provider request id with a permitted bounded shape, when a failure diagnostic is
  emitted, then the request id is included for correlation; an absent, malformed or oversized id
  is omitted rather than copied into the event.
- [ ] Given an error containing secrets, authorization headers, captured content and arbitrary
  provider text across its message, name, stack, cause, headers and request/response bodies, when
  the diagnostic is emitted, then none of those values or fields appear in the serialised log
  event.
- [ ] Given an unknown, malformed or non-object thrown value, when failure handling runs, then it
  emits a bounded `unknown` diagnostic without throwing a second error or serialising the value.
- [ ] Given any failure covered by the new diagnostics, when intent processing finishes the
  attempt, then the existing safe database error code, analysis record and three-attempt retry
  behaviour remain unchanged.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The diagnostic must describe the failure category, not reproduce the failure. After this task's PR
merges and production redeploys, operations should requeue the stored capture once, correlate the
new diagnostic with Anthropic, and address the revealed configuration or provider condition as a
separate change if one is required.
