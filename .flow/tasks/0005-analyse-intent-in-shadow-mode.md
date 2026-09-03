---
id: "later-0005"
title: "Analyse capture intent in Anthropic shadow mode"
status: "in_review"
priority: 3
project: "later"
owner: "claude-code-1788419549"
created: "2026-09-02"
started: "2026-09-03T07:12:29Z"
branch: "flow/later-0005-analyse-intent-in-shadow-mode"
pr: "https://github.com/CandidDan/later/pull/7"
issue: ""
blocked_reason: "Work is complete, pushed and gate-green on flow/later-0005-analyse-intent-in-shadow-mode, but the worker cannot open the PR: gh pr create and POST /repos/CandidDan/later/pulls both return 403 'GitHub Actions is not permitted to create or approve pull requests'. flow-open-pr holds FLOW_PAT but is push-triggered, and a push made with the Actions GITHUB_TOKEN does not trigger push workflows, so the safety net cannot fire for a flow-queue-runner worker. Needs a human to open the PR titled [later-0005] Analyse capture intent in Anthropic shadow mode (body ready to paste in Notes below), or a repo/infra fix. Issue creation is also barred for this token, so this task file is the only surface the worker could reach."
serves: ["G1"]
touches: [".env.example", "package.json", "pnpm-lock.yaml", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**"]
labels: ["intent", "anthropic", "experiment"]
notes: ["Depends on later-0003 for capture, analysis and job persistence. The Anthropic model is selected by configuration so the experiment can compare Haiku and Sonnet without changing code.", "2026-09-03: branch flow/later-0005-analyse-intent-in-shadow-mode pushed with the full implementation (src/lib/processing/**, src/lib/jobs/**, src/app/api/jobs/process/route.ts, .env.example, @anthropic-ai/sdk added). Typecheck is clean. NOT yet done: acceptance tests, build/lint/test/coverage gate, PR. Next action: write the proving tests under src/lib/processing/ and src/lib/jobs/, run pnpm build/lint/test/test:coverage, then open the PR titled [later-0005].", "2026-09-03: BUILD AND GATE COMPLETE. Branch flow/later-0005-analyse-intent-in-shadow-mode is pushed and rebased onto main. pnpm build passes; pnpm lint has 0 errors (3 pre-existing warnings in .flow/bin/*.mjs, untouched); pnpm test 88 passed / 13 files; pnpm test:coverage 86.64% statements against a floor of 15. All seven acceptance criteria have named proving tests. Diff stays inside the declared touches and does not touch .flow/. ONLY REMAINING STEP: open the PR. The worker could not — see blocked_reason. Exact next action: a human (or any actor that is not the Actions token) opens a PR from flow/later-0005-analyse-intent-in-shadow-mode into main titled exactly '[later-0005] Analyse capture intent in Anthropic shadow mode', pasting the description under 'Intended PR description' below. flow-status will then move this task to in_review and the qa/security/code-review checks will run. Do NOT re-claim or rebuild this task — the work exists on the branch."]
---

## Context

Later's central v0 experiment is whether the narrowest defensible reason for saving something can be inferred from capture-time context. Every capture should be analysed soon after persistence, but the result remains hidden from the user and each run is immutable experimental evidence. The user has an Anthropic API account and wants the test to support Haiku or Sonnet.

## Scope

- Define and runtime-validate the strict v0 intent result: content type; interest summary and confidence; atomic/reference/uncertain classification and confidence; underlying-source hints and confidence; resolution-required flag; and evidence tied to supplied capture context.
- Add a server-only Anthropic intent client configured by `ANTHROPIC_API_KEY` and `ANTHROPIC_INTENT_MODEL`, allowing a Haiku or Sonnet model to be selected without a code change.
- Build the model input solely from the immutable capture-time snapshot: raw text, extracted URLs, explicit user note, channel, deterministic platform, message metadata and available asset metadata. Do not include retrospective evaluation or later resolution data.
- Process a pending `intent_analysis` job, persist one append-only `capture_analyses` row containing the input snapshot, validated output, confidence, exact model identifier, prompt version and pipeline version, then mark the job complete.
- On invalid model output or provider failure, retain the capture, record the failed attempt and error safely, and leave the job retryable without overwriting any prior analysis.
- Enqueue one pending `source_resolution` job only when the validated result says resolution is required and an equivalent pending job does not already exist.
- Keep the interpretation in shadow mode: do not change capture acknowledgements or expose the analysis in user-facing UI.
- Do not implement source resolution, segment resolution, recommendations, summaries, resurfacing or the research console.

## Acceptance criteria

- [ ] Given valid capture-time context, when intent processing succeeds, then exactly one new immutable intent analysis is stored with a schema-valid result, its exact input snapshot, model id, prompt version and pipeline version, and the claimed job becomes complete.
- [ ] Given an explicit user note that conflicts with weaker surrounding context, when the model request is constructed, then the note is marked as the highest-signal evidence and the processor never fabricates retrospective fields outside the capture snapshot.
- [ ] Given a schema-invalid model response or Anthropic failure, when processing ends, then the original capture remains unchanged, the attempt and safe error are recorded, no successful analysis is invented, and the job remains eligible for the configured retry policy.
- [ ] Given two successful runs for the same capture, when the second run completes, then it appends a distinct analysis record and does not update or delete the first run.
- [ ] Given `resolutionRequired` is true, when a run completes, then exactly one pending source-resolution job exists; when it is false, no source-resolution job is added.
- [ ] Given either a configured Haiku or Sonnet model identifier, when the processor calls Anthropic, then it uses that configured identifier and records the exact model reported for the run without requiring a source change.
- [ ] Given an inbound capture acknowledgement path, when intent processing is unavailable or slow, then the acknowledgement behavior and stored capture are unaffected because no intent call is made in that request path.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The model identifier is intentionally configuration rather than a baked-in `latest` alias so each frozen run has explicit provenance. Model-quality comparison and prompt iteration happen through new analysis runs, never mutation.

---

## Intended PR description

Open the PR from `flow/later-0005-analyse-intent-in-shadow-mode` titled exactly `[later-0005] Analyse capture intent in Anthropic shadow mode`, with the following body.

Implements [`.flow/tasks/0005-analyse-intent-in-shadow-mode.md`](.flow/tasks/0005-analyse-intent-in-shadow-mode.md).

Every capture that already lands a pending `intent_analysis` job can now be analysed by Anthropic and stored as immutable experimental evidence. Nothing about the interpretation is user-visible: the acknowledgement path is untouched, and the only new surface is a secret-guarded `POST /api/jobs/process` that drains the queue out of band.

## Acceptance criteria

- [x] **Given valid capture-time context, when intent processing succeeds, then exactly one new immutable intent analysis is stored with a schema-valid result, its exact input snapshot, model id, prompt version and pipeline version, and the claimed job becomes complete.**
  Proven by `src/lib/processing/intent.test.ts` → "AC1 stores exactly one immutable analysis with its snapshot, model and versions", plus `src/lib/jobs/supabase-store.test.ts` → "AC1 claims a job with a conditional update, so a claimed job cannot be taken twice" and "AC1 loads the capture with its assets and no retrospective columns".

- [x] **Given an explicit user note that conflicts with weaker surrounding context, when the model request is constructed, then the note is marked as the highest-signal evidence and the processor never fabricates retrospective fields outside the capture snapshot.**
  Proven by `src/lib/processing/prompt.test.ts` → "AC2 marks an explicit note as the highest-signal evidence outranking weaker context" and "AC2 sends only the capture snapshot, naming no retrospective or resolution field"; `src/lib/processing/intent-input.test.ts` → "AC2 exposes only capture-time fields, with no retrospective or resolution data" and "AC2 allow-lists message metadata, so identifiers never reach the model input".

- [x] **Given a schema-invalid model response or Anthropic failure, when processing ends, then the original capture remains unchanged, the attempt and safe error are recorded, no successful analysis is invented, and the job remains eligible for the configured retry policy.**
  Proven by `src/lib/processing/intent.test.ts` → "AC3 records %s as a failed attempt and leaves the job retryable" (three cases: schema-invalid response, unusable provider response, Anthropic outage) and "AC3 records the failure reason without echoing provider or capture text"; `src/lib/processing/anthropic.test.ts` → "AC3 surfaces a schema-invalid model response as a schema error, not a result", "AC3 surfaces unparseable output as an analysis error", "AC3 surfaces a provider transport failure to the caller unchanged", "AC3 treats a refusal as a failed run rather than an empty success"; `src/lib/jobs/supabase-store.test.ts` → "AC3 returns a failed job to the queue as pending with its recorded error".

- [x] **Given two successful runs for the same capture, when the second run completes, then it appends a distinct analysis record and does not update or delete the first run.**
  Proven by `src/lib/processing/intent.test.ts` → "AC4 appends a distinct record on a second successful run and never edits the first" and "AC3 leaves a prior successful analysis untouched when a later run fails"; `src/lib/jobs/supabase-store.test.ts` → "AC4 writes an analysis with insert only, so a run can never overwrite a prior one".

- [x] **Given `resolutionRequired` is true, when a run completes, then exactly one pending source-resolution job exists; when it is false, no source-resolution job is added.**
  Proven by `src/lib/processing/intent.test.ts` → "AC5 enqueues exactly one pending source-resolution job when resolution is required", "AC5 adds no second job when an equivalent pending source-resolution job exists", "AC5 adds no source-resolution job when resolution is not required"; `src/lib/jobs/supabase-store.test.ts` → "AC5 counts only pending jobs of the requested type for the capture" and "AC5 enqueues a source-resolution job in the pending state".

- [x] **Given either a configured Haiku or Sonnet model identifier, when the processor calls Anthropic, then it uses that configured identifier and records the exact model reported for the run without requiring a source change.**
  Proven by `src/lib/processing/anthropic.test.ts` → "AC6 calls %s exactly as configured and records the model the API reports" (parameterised over `claude-haiku-4-5` and `claude-sonnet-5`, with the API reporting a different identifier back) and "AC6 requires the model to be configured rather than defaulting to one in code".

- [x] **Given an inbound capture acknowledgement path, when intent processing is unavailable or slow, then the acknowledgement behavior and stored capture are unaffected because no intent call is made in that request path.**
  Proven by `src/lib/processing/shadow-mode.test.ts` → "AC7 acknowledges and persists a capture while intent processing is unavailable" (the Anthropic constructor is mocked to throw, and is asserted never to be reached), "AC7 keeps the acknowledgement path free of any intent-processing import", "AC7 confines intent analysis to the job-processing route", "AC7 exposes no analysis result in any user-facing page"; plus `src/lib/jobs/handler.test.ts` → the three unauthenticated/misconfigured cases, which assert processing is never invoked.

## Gate

| Check | Result |
| --- | --- |
| `pnpm build` | passes |
| `pnpm lint` | 0 errors; 3 pre-existing warnings in `.flow/bin/*.mjs`, untouched by this diff |
| `pnpm test` | 88 passed / 13 files |
| `pnpm test:coverage` | 86.64% statements (floor is 15) |

## Notes for review

- **The model identifier is configuration, never code.** `ANTHROPIC_INTENT_MODEL` selects the model and the identifier the API *reports* is what gets stored, so each frozen run carries its own provenance. The request deliberately sets nothing beyond the JSON schema and a token ceiling — `thinking` and `effort` are not supported uniformly across the Haiku and Sonnet models this experiment compares, and the point of the task is that swapping between them is an environment change.
- **Message metadata is allow-listed, not deny-listed.** Only `mediaCount`, `segmentCount` and `messageType` reach the model. Phone numbers, WhatsApp ids and profile names are excluded by construction rather than by remembering to strip them, so a new provider field cannot leak private capture context by default.
- **Recorded failures carry a code and the error's class, never its message.** Provider errors and rejected model output can both quote the capture back at us, and `last_error` is the least protected place that text could land.
- **`POST /api/jobs/process` requires a `JOBS_PROCESS_SECRET` bearer token**, compared in constant time, and returns 503 rather than running open when the secret is unset. The task did not specify an auth story for the endpoint; leaving a queue drain unauthenticated seemed the wrong default, so this is the one judgement call in the diff worth a second opinion.
- **No migration was needed** — `capture_analyses` and `capture_jobs` already exist from later-0002/0003, and `supabase/**` is outside this task's `touches`.

---

**TL;DR** — Captures are now analysed by a configurable Anthropic model into append-only `capture_analyses` rows, entirely in shadow mode; all seven acceptance criteria have named proving tests and build/lint/test/coverage are green.

1. Review the PR, paying particular attention to the `JOBS_PROCESS_SECRET` auth decision on `/api/jobs/process` — that was the one call the task didn't settle.
2. Merge when satisfied; `flow-done` will move later-0005 to `done`.
