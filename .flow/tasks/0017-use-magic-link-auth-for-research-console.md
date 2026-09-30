---
id: "later-0017"
title: "Use magic-link authentication for the research console"
status: "done"
priority: 3
project: "later"
owner: "01a05aa4-6d8d-7920-8c9e-1f2140442ba4"
created: "2026-09-30"
started: "2026-09-30T02:59:24Z"
branch: "flow/later-0017-magic-link-research-auth"
pr: "https://github.com/CandidDan/later/pull/27"
issue: ""
blocked_reason: ""
blocked_by: []
serves: ["G1"]
touches: ["README.md", "src/app/research/**"]
labels: ["research", "authentication", "supabase", "security"]
notes:
  - "The evaluator has configured Supabase Auth URL settings for notfor.now. Production still needs the browser-safe Supabase variables and RESEARCH_USER_ID configured separately before the console can load; that is an operator configuration step, not this task's code scope."
---

## Context

The private research console is the v0 mechanism for judging Later's frozen intent inferences
without hindsight, serving G1. It currently asks the single evaluator for an email and password.
For this solo experiment, a password is needless friction and makes recalling a saved capture
less likely. The evaluator has chosen email magic-link sign-in instead.

Supabase's browser client should initiate the magic link. The existing post-auth session check
and server-side `RESEARCH_USER_ID` authorization remain the authority for access; an emailed link
must not create a new evaluator or broaden access.

## Scope

- Replace the research console's email-and-password sign-in interaction with an email-only
  magic-link request.
- Request the link through Supabase passwordless email sign-in, redirecting back to the deployed
  `/research` route and disallowing automatic user creation.
- Provide an accessible pending and sent state that tells the evaluator to check their email
  without revealing whether that address is an eligible account.
- Preserve the existing session restoration, research API bearer-token calls and server-side
  authorization behavior after the user follows a valid link.
- Update the operator documentation for the required Supabase Auth site/redirect configuration
  and the magic-link-only research-console flow.

Out of scope: WhatsApp authentication, password reset, account creation, OAuth providers,
multi-user access, changes to Supabase RLS or `RESEARCH_USER_ID`, and changes to capture,
analysis, recall, reveal or rating semantics.

## Acceptance criteria

- [ ] Given a signed-out visitor at `/research`, when the sign-in panel renders, then it requests
  only an email address and does not render, submit or retain a password field.
- [ ] Given a valid email submission, when the visitor requests access, then the browser calls
  Supabase passwordless email sign-in with a redirect to that deployment's `/research` route and
  automatic user creation disabled.
- [ ] Given Supabase accepts a magic-link request, when the request completes, then the console
  shows a non-enumerating "check your email" state and does not expose an access token or claim
  that the address is authorized.
- [ ] Given Supabase rejects a magic-link request, when the request completes, then the console
  returns to a usable email form with a generic failure message and does not disclose provider
  error details or account existence.
- [ ] Given the visitor returns from a valid magic link with a Supabase session, when the console
  initializes, then it loads the existing research flow; the existing API authorization still
  denies a session whose user is not `RESEARCH_USER_ID`.
- [ ] Given an operator configures the console, when they follow the README instructions, then
  they can identify the required Supabase Site URL, allowed `/research` redirect URL and the fact
  that the evaluator must already exist as the configured research user.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- Use the current deployment origin when constructing the redirect URL so preview and production
  environments do not silently redirect to one another; the operator must allow the intended
  production URL in Supabase Auth.
- Supabase Auth's default magic-link email template must retain its confirmation-link variable.
  Do not send a link from Later or add an email provider in this task.
