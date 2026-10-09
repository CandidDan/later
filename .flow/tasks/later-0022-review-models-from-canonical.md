---
id: "later-0022"
title: "Reviewer models come from canonical Flow: drop this repo's review model pins"
status: "in_review"
priority: 2
project: "later"
owner: "claude-session-012CTneThg94vo5drhs7QSEY"
created: "2026-10-09"
started: "2026-10-09T09:19:05Z"
branch: "review-models-from-canonical"
pr: "https://github.com/CandidDan/later/pull/45"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["maintenance"]
intent: ""
touches:
  - ".flow/config.yml"
notes:
  - "2026-10-09 (orchestrator): Dan's rule: adopting repos never set reviewer models; canonical Flow's DEFAULT_MODELS decide (3.3.1: qa/guide claude-sonnet-5-5, code-review and security claude-opus-5-5). Canonical flow-0144 makes unset silent and a set key the warning. Written after the PR existed (my miss: the PR was opened without a task); the PR is retitled with this id."
---

## Context

This repo's `.flow/config.yml` pins reviewer models. Pins go stale silently when canonical moves on;
canonical's defaults are the single decision.

## Scope

**Does:** remove `model`, `code_review_model` and `security_model` from `review:` in
`.flow/config.yml`, with a comment saying where the defaults live; update any repo test that
asserted the old pins so it asserts none are set.
**Does not touch:** `security_paths`, anything else in config, `.flow/bin/**`.

## Acceptance criteria

- [ ] Given `.flow/config.yml`, then `review:` sets none of `model`, `code_review_model`, `security_model`
      (any existing config test that read the pins now asserts their absence).
- [ ] build + lint + test pass.
