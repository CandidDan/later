---
id: "later-0012"
title: "Prepare and validate the v0 production launch"
status: "ready"
priority: 3
project: "later"
owner: ""
created: "2026-09-16"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: ""
serves: ["maintenance"]
touches: [".env.example", "README.md", "package.json", "src/lib/operations/**"]
labels: ["operations", "launch", "documentation", "maintenance"]
notes: ["This is the final readiness pass before the six-week Capture & Intent v0 experiment. It corrects the stale intent-only operator documentation and makes configuration readiness checkable without deploying, calling providers or revealing secrets. External account setup, DNS, secret entry, database migration execution and the live smoke run remain human-operated steps described by the runbook, not actions performed by the worker or CI."]
---

## Context

The approved build batch is merged, but the repository does not yet provide a reliable launch handoff. The root README still describes an earlier intent-only processor that claimed up to ten jobs, while the production route now rotates across intent, media, email, source and segment queues and processes at most two jobs per request. Configuration is spread across `.env.example`, channel-specific notes and migrations, so an operator could deploy a technically green build with a missing channel, disabled research console or incomplete job schedule.

Before `notfor.now` is used for the six-week experiment, Later needs one accurate source-of-truth runbook and a credential-safe local readiness check. This is operational maintenance, not a new product phase.

## Scope

- Replace the scaffold/stale root README content with an ordered v0 production launch and rollback runbook covering `notfor.now` on Vercel, Supabase migrations/Auth/Vault/cron, Twilio WhatsApp, Resend inbound email, Anthropic intent/source/segment models and the private `/research` console.
- Inventory every production environment variable from `.env.example`, identifying where it is configured, whether it is secret or browser-safe, which capability needs it and the safe disabled/failure behavior when it is absent or invalid.
- Add a local launch-readiness command exposed through `package.json`. Given an environment, it validates the complete v0 configuration offline, exits non-zero for missing or malformed required settings, and reports only safe variable names/capability states—never values, headers, captured content or derived secret material.
- Add automated outcome tests for the readiness command and for the runbook/configuration contract so changes to channels, processing stages, endpoints or environment keys cannot silently make the launch instructions stale again.
- Define a repeatable post-deploy smoke matrix for WhatsApp text, WhatsApp media, inbound email with an attachment, background intent/source/segment processing and `/research` recall-before-reveal. Each step must state the safe observable result and safe diagnostic query or response without dumping secrets or captured content.
- Include pause, rollback and recovery guidance that preserves failed jobs and immutable analyses rather than resetting evidence from the experiment.
- Do not deploy, alter DNS, create or mutate external accounts/resources, enter or rotate secrets, make live provider calls in tests, add monitoring SaaS, build resurfacing/recommendations/summaries/playback, or change capture/analysis behavior.

## Acceptance criteria

- [ ] Given an environment with one or more required v0 settings missing or malformed, when the launch-readiness command runs, then it exits non-zero and identifies the affected variable names and capabilities without printing any configured value or secret-derived material.
- [ ] Given a complete valid v0 environment, when the launch-readiness command runs, then it exits successfully and reports WhatsApp capture, media retrieval, inbound email, intent/source/segment processing, scheduled job dispatch and the private research console as ready without making a network request.
- [ ] Given the current application and `.env.example`, when the runbook contract tests execute, then every declared environment key and production endpoint is documented with its configuration surface, sensitivity, dependent capability and safe absent/invalid behavior, and the processor is described as serving all five current queues with the current two-job request limit.
- [ ] Given an operator following the production runbook from a fresh project, when they proceed in order, then they can configure `notfor.now`, deploy Vercel, apply the complete migration chain, configure Supabase Auth/Vault/cron, connect Twilio and Resend, and pause or roll back dispatch without placing a credential in source control, SQL text, command arguments or diagnostic output.
- [ ] Given a deployed v0 environment, when the documented smoke matrix is followed, then each supported capture path has an immediate acknowledgement check, a durable capture/job/analysis check, and a recall-before-reveal research check using only safe counts, ids, statuses and timestamps; failures direct the operator to bounded diagnostics and preserve the original evidence.
- [ ] Given sentinel credential values and captured-content strings in the test environment, when every readiness and runbook-contract test runs, then no sentinel appears in stdout, stderr, snapshots or thrown error text and no test attempts an external network connection.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The readiness command is deliberately offline and side-effect free. The human remains responsible for external configuration and the live smoke run. A successful readiness check means the supplied configuration is structurally complete; it does not claim that provider credentials, DNS propagation or production connectivity are valid.
