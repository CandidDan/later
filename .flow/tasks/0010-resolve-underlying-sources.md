---
id: "later-0010"
title: "Resolve the underlying source of a capture"
status: "in_review"
priority: 3
project: "later"
owner: "codex-01a0a00d-6a7d-71c2-a910-e2100d2f0b22"
created: "2026-09-06"
started: "2026-09-14T13:14:48Z"
branch: "flow/later-0010-resolve-underlying-sources"
pr: "https://github.com/CandidDan/later/pull/13"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: [".env.example", "src/app/api/jobs/process/**", "src/lib/jobs/**", "src/lib/processing/**", "src/lib/resolution/**", "supabase/migrations/*source_resolution.sql", "supabase/tests/database/*source_resolution.test.sql"]
labels: ["resolution", "sources", "anthropic", "security"]
notes:
  - "Run after later-0008. Source resolution remains independently measurable from intent. Direct canonical URLs should resolve deterministically; indirect references may use bounded public metadata plus Anthropic, and unknown is a successful honest outcome."
  - "2026-09-14 worker handoff: Eligibility and coordination are genuinely complete. origin/main was fetched at 8840180, later-0008 and later-0009 were confirmed done, later-0010 remained ready, and no in_progress task overlapped its declared touches. The atomic metadata-only claim landed on main in 7dc2da9 with owner codex-01a0a00d-6a7d-71c2-a910-e2100d2f0b22 and started 2026-09-14T13:14:48Z. The board-builder snapshot was refreshed and pushed in 039b18f. Remote branch flow/later-0010-resolve-underlying-sources exists at 039b18f. Nothing only looks done: no product implementation, tests, local gates, rebase, PR, hosted reviews or deployment has occurred. No product decision was finalized. Mandatory session-hygiene stop: the first broad repository search returned truncated output, so this worker stopped before editing product code. Exact next action: start a fresh worker session, read AGENTS.md, .flow/PROTOCOL.md, .flow/config.yml and this task, fetch current main, verify this claim and that no PR exists, resume flow/later-0010-resolve-underlying-sources without re-claiming, inspect the job/processing/database contracts in small bounded reads, implement only later-0010 within its touches with outcome-asserting tests for all seven criteria, run build/lint/test/coverage and the source-resolution pgTAP suite, rebase current main, rerun gates if it moved, push and open exactly one [later-0010] PR. Do not start later-0011."
---

## Context

A capture may be the content itself or a reference to something larger, such as an Instagram clip pointing to a full podcast episode. Intent processing already queues `source_resolution` only when required. This task must identify the underlying source where defensible while recording uncertainty rather than turning weak hints into confident matches.

## Scope

- Extend the analysis and job contracts to process `source_resolution` jobs independently of intent jobs.
- Define and runtime-validate a strict source-resolution result containing resolved/unresolved status, canonical source type, title, creator, canonical URL, optional duration/transcript URL, confidence and evidence.
- Resolve direct recognized source URLs deterministically from their canonical identifiers and bounded public metadata where possible.
- For indirect references, build an Anthropic request from the immutable capture snapshot, the selected successful intent analysis and safely fetched public metadata. Record the exact input snapshot, result, model id, prompt version and pipeline version in a new immutable `source_resolution` analysis.
- Protect every submitted or discovered URL fetch against SSRF: permit public HTTPS only, resolve and reject private/loopback/link-local destinations before connection and after redirects, cap redirects, time and bytes, and accept only explicitly supported metadata content types.
- Treat unresolved/unknown as a successful measurable result. Retry provider/network/schema failures under the shared job policy without changing the capture or prior analyses.
- Enqueue exactly one `segment_resolution` job only when a source is resolved and the result identifies an available transcript or another supported segmentable representation.
- Keep source-resolution accuracy separate in research data and APIs from intent accuracy.
- Do not scrape authenticated/private platform pages, download full audio/video, generate transcripts, infer a segment without source material, summarise, recommend or expose a consumer library.

## Acceptance criteria

- [ ] Given a direct recognized source URL with valid public metadata, when its resolution job runs, then Later stores one immutable resolved result with canonical identity, confidence, evidence and complete model/pipeline provenance where a model was used.
- [ ] Given an indirect clip or post with defensible source clues, when bounded metadata and Anthropic agree on a source, then the stored result cites only evidence present in its immutable input snapshot and preserves the original capture and intent analysis unchanged.
- [ ] Given insufficient or conflicting evidence, when resolution completes, then it stores an explicit unresolved result with confidence rather than inventing a title, creator, URL or transcript.
- [ ] Given a URL targets or redirects to loopback, private, link-local, non-HTTPS or an unsupported/oversized response, when metadata retrieval is attempted, then the request is rejected without exposing internal network data and the unsafe content never reaches the model.
- [ ] Given a transient fetch, Anthropic or schema failure, when processing ends, then the source job follows the shared retry policy, records only safe failure detail, and does not overwrite any successful analysis.
- [ ] Given a resolved source has an available supported transcript representation, when the source job completes, then exactly one pending segment-resolution job exists; otherwise no segment job is created.
- [ ] Given intent and source results are queried for research, when their outcomes are returned, then each retains its own analysis type and confidence so one stage cannot be counted as success for the other.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

Use a separately configured Anthropic resolution model id and record the model reported by the provider. Public metadata is evidence, not permission to crawl broadly. The resolver should make a small bounded number of requests per capture and stop cleanly at unknown.
