---
id: "later-0021"
title: "Render readable research results after recall"
status: "in_progress"
priority: 3
project: "later"
owner: "codex-cloud-6d52f881b078"
created: "2026-10-05"
started: "2026-10-08T03:38:30Z"
branch: "flow/later-0021-readable-research-results"
pr: "https://github.com/CandidDan/later/pull/40"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G1"]
touches: ["src/app/research/**", "src/app/api/research/**", "src/lib/research/**", "src/lib/revisit/**"]
labels: ["revisit", "research"]
notes: ["Approved direction: make daily saves recognisable, then provide a small return surface; keep research separate.", "2026-10-08: Human requested a fresh session for the next task. Dependencies later-0018, later-0019 and later-0020 have merged; stale dependency block cleared. Preserve existing touches and acceptance criteria. Continue the approved cloud execution preference: no local Docker on the human workstation; full real database proof runs in cloud/hosted CI and must not be skipped."]
---

## Context

Research currently presents original text/filenames before recall and raw model JSON afterward. The user cannot easily recognise a week-old capture or assess the result. Use later-0018's rich card after recall, and render the frozen intent result in readable sections while preserving the existing unaided-recall contract. The separate return experience is later-0020.

## Scope

- Keep pre-recall cues limited to the existing capture-time fields: original text/note, original attachment filenames/types, channel/platform and readable saved date. Do not expose fetched titles, creator metadata, image bytes, inferred interests, source/segment results or rich-card data before recall is durably stored.
- After persisted recall, render the shared recognisable card and the existing frozen intent results as labelled readable fields: inferred interest, content type, classification, specificity and rationale where the validated schema supplies them. Preserve uncertainty and make clear these are model interpretations, not source facts.
- Keep each run separate with its own existing rating form and analysis identity. Put model/prompt/pipeline/confidence and unchanged raw JSON in an optional accessible technical-details disclosure. Do not generate new summaries or reanalyse captures.
- Load rich card/asset data only after server-confirmed recall, including resumed sessions. Keep failures in this optional enhancement from blocking rating of already revealed runs. Return-path exposure writes may occur here after recall; existing recall remains valid.
- No research schema changes, new rating dimensions, source/segment evaluation, selection policy rewrite, production backfill or forced revisit workflow. Follow the exposure enforcement from later-0019 if it has landed; do not bypass it.

## Acceptance criteria

- [ ] Given a fresh recall phase, when the page and network calls are inspected, then only existing capture-time cues and readable saved date appear; rich-card/preview requests and inferred/fetched fields are absent until persisted recall is confirmed.
- [ ] Given persisted recall or a resumed revealed evaluation, when the page renders, then the rich card and readable frozen intent sections appear with uncertainties intact, and technical details/raw JSON are available only through the optional disclosure.
- [ ] Given multiple frozen runs for one capture, when ratings are submitted, then each labelled interpretation/form remains bound to its own analysis/evaluation ID and the existing completion/retry behaviour is preserved.
- [ ] Given malformed/unknown result fields or failed card/preview loading, when reveal renders, then it shows an honest unavailable fallback, preserves the raw result in technical details and leaves the existing rating controls usable.
- [ ] Given an unsaved recall, denied reveal or stale response arriving in the recall phase, when the client handles it, then neither readable interpretations nor rich cards can enter the pre-recall screen.
- [ ] Given long results and keyboard use, when readable sections and technical disclosures render, then text wraps, disclosure controls and rating forms are labelled, and no arbitrary result HTML executes.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The approved boundary is unchanged unaided recall followed by richer recognition. No new AI/provider calls are part of rendering. This task may follow later-0018 independently of the return UI but shares `touches` with later-0019/0020 and must not run concurrently with them.
