---
id: "later-0011"
title: "Resolve the relevant segment from available source material"
status: "blocked"
priority: 3
project: "later"
owner: "claude-later-0011-20260915T071420Z"
created: "2026-09-06"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Hard dependency unmet: later-0011 builds entirely on later-0010, which is still in_review in unmerged PR #13. On main there is no segment_resolution job type, no source_resolution analyses table or migration, and no src/lib/resolution/** at all (result schema, SSRF-safe bounded fetch boundary, Anthropic resolver, transcript-backed segment enqueue) - that whole 2110-line foundation exists only on flow/later-0010-resolve-underlying-sources. Every one of the seven acceptance criteria references a prior successful source-resolution analysis, its analysis id, or 'the same SSRF-safe, bounded fetch boundary as source resolution', so none can be built or proven on main. The two tasks also declare near-identical touches (.env.example, src/app/api/jobs/process/**, src/lib/jobs/**, src/lib/processing/**, src/lib/resolution/**). The only ways forward were to branch off an unmerged PR branch (protocol step 3 requires branching off latest main, and a kickback on #13 would tangle both PRs) or to reimplement later-0010's foundation inside later-0011 (scope widening plus a guaranteed merge conflict) - neither is the worker's call. Unblock condition: merge PR #13 so flow-done marks later-0010 done, then set later-0011 back to ready; no spec change is needed."
serves: ["G1"]
touches: [".env.example", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**", "src/lib/resolution/**", "supabase/migrations/*segment_resolution.sql", "supabase/tests/database/*segment_resolution.test.sql"]
labels: ["resolution", "segments", "anthropic", "experiment"]
notes:
  - "Run after later-0010. This v0 task resolves only against source material that is already publicly available and identified by source resolution, such as plain text, JSON or WebVTT transcripts. It deliberately does not buy or build transcription infrastructure."
  - "2026-09-15 worker blocked: Did NOT claim later-0011 - it was never startable, so no in_progress claim was pushed, no branch was cut and no product code was written. Verified against origin/main at 11338fe: src/lib/resolution/ does not exist, supabase/migrations/ has no *source_resolution.sql, and CaptureJobType in src/lib/jobs/types.ts lists intent_analysis, source_resolution, media_download and email_enrichment but no segment_resolution. git diff --stat main...origin/flow/later-0010-resolve-underlying-sources shows 24 files and 2110 insertions still unmerged, including the full src/lib/resolution/** module this task must extend. PR #13 is OPEN and MERGEABLE with flow-gates, qa, code-review and security all SUCCESS (only flow-open-pr/open-pr failed, which does not gate merge) and no reviewDecision yet - it is waiting on human validation, not on more agent work. Nothing about later-0011 only looks done; nothing was started. Exact next action: a human reviews and merges PR #13; flow-done then sets later-0010 done; the orchestrator then flips later-0011 back to status ready with owner and blocked_reason cleared, and a fresh worker runs it against a main that already contains the source-resolution foundation. No spec or touches change is required."
---

## Context

When the captured interest concerns only part of a larger source, Later needs to determine which section corresponds to that interest. This is a separate hypothesis from understanding the interest or finding the source, so the result needs its own immutable analysis and confidence. Many sources will not expose a transcript; an explicit unresolved outcome is more useful evidence than a fabricated timestamp.

## Scope

- Process `segment_resolution` jobs only after a successful source-resolution analysis identifies a supported public transcript or text representation.
- Retrieve that material through the same SSRF-safe, bounded fetch boundary as source resolution, accepting only documented text, JSON and WebVTT representations.
- Define and runtime-validate a strict segment result with resolved/unresolved status, start/end timestamps where the source is timed, section boundaries where it is text, a short identifying excerpt or label, confidence and evidence tied to the supplied source material.
- Ask Anthropic to match the frozen captured interest to the available source material without summarising or rewriting the source. Record the exact source-analysis id, transcript identity/digest, model id, prompt version, pipeline version and output in a new immutable `segment_resolution` analysis.
- Validate that timestamps are ordered, non-negative and within a known source duration, and that text boundaries/excerpts actually occur in the supplied material.
- Store an explicit unresolved result when source material is absent, unsupported, contradictory or insufficient. Reserve job failure/retry for operational or schema failures.
- Make segment outcomes and confidence independently available to the research evaluation API without changing earlier intent/source ratings.
- Do not generate a transcript, download or edit full media, build playback, create clips, summarise, narrate, recommend, resurface or add a consumer-facing session.

## Acceptance criteria

- [ ] Given a resolved timed source and a supported transcript containing the captured interest, when segment processing succeeds, then one immutable result identifies ordered in-range start/end timestamps, confidence and evidence that exists in the supplied transcript.
- [ ] Given a resolved text source, when the relevant material is found, then the result identifies valid section boundaries or an excerpt present in that source without fabricating audio timestamps.
- [ ] Given no transcript, an unsupported representation or insufficient/contradictory evidence, when segment processing completes, then it records an explicit unresolved result and does not invent a timestamp, excerpt or section.
- [ ] Given a model returns negative, reversed, out-of-duration timestamps or an excerpt absent from the source material, when validation runs, then no successful segment result is stored and the job follows the safe retry/terminal-failure policy.
- [ ] Given a transcript URL targets or redirects to a prohibited network destination or exceeds the configured bounds, when retrieval is attempted, then it is rejected before model use and no internal or oversized content is persisted.
- [ ] Given the same segment job is retried or two workers overlap, when processing succeeds, then at most one successful analysis is associated with that job while all earlier intent and source analyses remain unchanged.
- [ ] Given research requests the three resolution stages, when results are returned, then intent, source and segment each expose their own status/confidence and can be rated independently.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

This task intentionally measures the segment resolver only on sources for which suitable material exists. Transcript acquisition and transcription are separate product/cost decisions and remain outside this approved batch.
