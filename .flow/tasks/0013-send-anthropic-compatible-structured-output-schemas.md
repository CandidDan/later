---
id: "later-0013"
title: "Send Anthropic-compatible structured-output schemas"
status: "in_review"
priority: 3
project: "later"
owner: "codex-01a0d0e0-d8ac-7222-be12-4c2c529f371a"
created: "2026-09-24"
started: "2026-09-24T00:47:54Z"
branch: "flow/later-0013-anthropic-compatible-schemas"
pr: "https://github.com/CandidDan/later/pull/18"
issue: ""
blocked_reason: ""
serves: ["G1"]
touches: ["src/lib/processing/**", "src/lib/resolution/**"]
labels: ["bug", "anthropic", "intent", "production"]
notes:
  - "Production evidence on 2026-09-23: a WhatsApp YouTube capture persisted successfully, but every Anthropic attempt ended as provider_unavailable before any model id was recorded. The configured key is used successfully elsewhere. The intent, source and segment adapters pass raw JSON schemas containing minLength, minimum and maximum to output_config.format; Anthropic documents those keywords as unsupported and returns HTTP 400. The installed SDK already includes jsonSchemaOutputFormat(), which transforms provider-facing schemas while local runtime validators can retain the full constraints."
---

## Context

Later's first live WhatsApp capture proved the inbound, persistence and scheduler path, but intent
analysis exhausted its retries without producing a model response. The credential is used by other
applications, the configured Haiku model supports structured outputs, and Anthropic's service was
operational. The failure is deterministic in Later's request: all three Anthropic adapters send raw
JSON schemas containing numerical and string constraints that Anthropic structured outputs reject.

The current failure classifier then collapses that HTTP 400 into `provider_unavailable`, making an
invalid request look like an outage or credential problem. Fixing only intent would defer the same
production failure to source and segment resolution, because both use the same raw-schema pattern.

Official constraint reference:
https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations

## Scope

- Make the provider-facing structured-output schemas for intent, source resolution and segment
  resolution compatible with Anthropic while retaining the stricter existing runtime result
  validation inside Later.
- Cover the transformation contract for all three adapters so unsupported schema keywords cannot
  return unnoticed.
- Distinguish an Anthropic HTTP 400 invalid request from a provider outage using existing safe,
  allowlisted error codes; never persist provider-controlled error text or captured content.
- Preserve prompt meaning, result shapes, provider-reported model provenance and the current retry
  boundary.
- Do not change model selection, environment variables, database migrations, prompts, capture
  behaviour, source-material retrieval, or the research UI.
- Do not perform a live provider call, production deployment or production job retry from the
  worker. Those are post-merge operational verification steps.

## Acceptance criteria

- [ ] Given the intent result contract retains its non-empty-string and confidence bounds locally,
  when the intent adapter constructs an Anthropic request, then its provider-facing schema contains
  no unsupported string or numerical constraint keywords and still preserves the required object
  shape, enums and `additionalProperties: false` boundaries.
- [ ] Given the source-resolution result contract retains its duration and confidence bounds
  locally, when the source adapter constructs an Anthropic request, then its provider-facing schema
  is Anthropic-compatible and preserves the nullable fields, required fields, enums and closed
  object shape.
- [ ] Given the segment-resolution result contract retains its locator and confidence bounds
  locally, when the segment adapter constructs an Anthropic request, then its provider-facing
  schema is Anthropic-compatible and preserves the nullable locators, required fields, enums and
  closed object shape.
- [ ] Given Anthropic returns structured JSON that satisfies the transformed provider schema but
  violates a stricter Later constraint removed for transport, when any of the three pipelines
  validates that result, then it rejects the result through the existing `result_schema_invalid`
  outcome rather than publishing a successful analysis.
- [ ] Given Anthropic rejects a request with HTTP 400, when any of the three processors records the
  attempt, then it uses the existing safe `provider_response_invalid` code rather than
  `provider_unavailable`; authentication, rate-limit, network and 5xx failures remain
  `provider_unavailable`, and no provider error message is persisted.
- [ ] Given a valid structured result, when intent, source or segment processing succeeds, then the
  existing result contract and provider-reported model id are preserved unchanged.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

The existing runtime parsers remain the authority for Later's stricter semantics. Transforming the
schema sent to Anthropic must not weaken those post-response checks. After the PR merges, operations
will redeploy production and requeue the already-stored live capture to prove the fix end to end.
