---
id: "later-0011"
title: "Resolve the relevant segment from available source material"
status: "ready"
priority: 3
project: "later"
owner: ""
created: "2026-09-06"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**", "src/lib/resolution/**", "supabase/migrations/*segment_resolution.sql", "supabase/tests/database/*segment_resolution.test.sql"]
labels: ["resolution", "segments", "anthropic", "experiment"]
notes: ["Run after later-0010. This v0 task resolves only against source material that is already publicly available and identified by source resolution, such as plain text, JSON or WebVTT transcripts. It deliberately does not buy or build transcription infrastructure."]
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
