---
id: "later-0009"
title: "Evaluate captured intent without hindsight"
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
touches: [".env.example", "src/app/research/**", "src/app/api/research/**", "src/lib/research/**", "src/lib/supabase/**", "supabase/migrations/*create_capture_evaluations.sql", "supabase/tests/database/*capture_evaluations.test.sql"]
labels: ["research", "evaluation", "intent", "security"]
notes: ["This task depends only on the completed capture and immutable-analysis schema. Flow's conservative migration-path overlap keeps this batch sequential even though the research surface is otherwise independent. The research console is experiment tooling, not a Later library or consumption surface."]
---

## Context

Later's first hypothesis cannot be judged by reading model output immediately: that would contaminate the user's later recollection. The approved evaluation sequence asks for unaided recall first, persists that answer, and only then reveals the frozen interpretation. The console must bind every rating to the exact immutable analysis run so Haiku, Sonnet and later prompt versions can be compared without guessing which output was judged.

## Scope

- Add a versioned `capture_evaluations` schema linked to the capture, evaluator and exact `capture_analyses` row. Store recall status (`remembered`, `partial`, `cannot_remember`), optional remembered interest, intent accuracy (`correct`, `close`, `wrong`), still-interested and consumed-before-evaluation answers, notes and phase timestamps.
- Apply RLS so an authenticated user can evaluate only their own captures and cannot see or mutate another user's evaluations. Analysis records remain immutable.
- Add authenticated research APIs that select an unevaluated capture/run and return only the original capture context during the recall phase.
- Persist the recall response before any API response is permitted to include the inferred interest, model result or model identity. Enforce this on the server rather than relying on hidden client state.
- After recall is stored, reveal the exact analysis result and collect the accuracy and follow-up answers. If more than one successful intent run exists, retain one recall answer and rate each run separately while binding every rating to its analysis id.
- Build a minimal `/research` interface that presents one evaluation at a time, clearly separates recall and reveal, supports keyboard/touch use, and displays operational empty/error states without becoming a browsable archive, backlog or consumer library.
- Authenticate with Supabase Auth and allow access only to the configured research user id for v0. Keep service-role credentials out of the browser; the API must verify the presented user session independently.
- Do not add recommendations, summaries, resurfacing, playback, source/segment resolution, aggregate success claims or a visible queue count.

## Acceptance criteria

- [ ] Given an unauthenticated request or a signed-in user who does not own the capture and match the configured research user, when any research page or API is requested, then no capture, analysis or evaluation data is returned.
- [ ] Given an unevaluated capture with a successful intent analysis, when the recall phase loads, then it shows the original capture context and recall questions while the response contains no inferred summary, model result, model id or confidence.
- [ ] Given the user submits remembered, partial or cannot-remember recall, when the server accepts it, then the recall answer and timestamp are durably stored before that response reveals any analysis field.
- [ ] Given recall is already stored, when the reveal phase loads, then it shows the exact immutable analysis selected for evaluation and records correct, close or wrong plus the remaining follow-up answers against that analysis id.
- [ ] Given two successful intent runs exist for one capture, when the evaluation is completed, then one unaided recall response is reused and each run receives a distinct rating tied to its own model/prompt/pipeline provenance without either analysis being modified.
- [ ] Given there are no eligible analyses, a request fails, or a submission is repeated, when the console handles the condition, then it presents a stable empty/error/idempotent outcome and does not fabricate or duplicate research data.
- [ ] Given the `/research` interface is inspected, when navigating it, then only one capture is presented for evaluation at a time and no consumer-facing archive, backlog count, recommendation or inferred intent appears before reveal.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

For v0, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `RESEARCH_USER_ID` are explicit configuration. The public key may reach the browser; the service-role key must not. The server is the reveal boundary—client-side CSS or state is not sufficient protection against hindsight contamination.
