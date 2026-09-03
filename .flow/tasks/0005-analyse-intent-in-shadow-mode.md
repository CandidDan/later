---
id: "later-0005"
title: "Analyse capture intent in Anthropic shadow mode"
status: "in_progress"
priority: 3
project: "later"
owner: "claude-code-1788419549"
created: "2026-09-02"
started: "2026-09-03T07:12:29Z"
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "package.json", "pnpm-lock.yaml", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**"]
labels: ["intent", "anthropic", "experiment"]
notes: ["Depends on later-0003 for capture, analysis and job persistence. The Anthropic model is selected by configuration so the experiment can compare Haiku and Sonnet without changing code.", "2026-09-03: branch flow/later-0005-analyse-intent-in-shadow-mode pushed with the full implementation (src/lib/processing/**, src/lib/jobs/**, src/app/api/jobs/process/route.ts, .env.example, @anthropic-ai/sdk added). Typecheck is clean. NOT yet done: acceptance tests, build/lint/test/coverage gate, PR. Next action: write the proving tests under src/lib/processing/ and src/lib/jobs/, run pnpm build/lint/test/test:coverage, then open the PR titled [later-0005]."]
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
