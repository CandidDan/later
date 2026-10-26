---
id: "later-0036"
title: "Release Later iOS v1 and verify saving and listening end to end on a physical iPhone"
status: "blocked"
priority: 2
project: "later"
owner: ""
created: "2026-10-26"
started: ""
branch: ""
pr: ""
issue: ""
blocked_reason: "Waits for the last build tasks: later-0033 (Siri), later-0034 (share extension) and later-0035 (TestFlight delivery)."
blocked_by: ["later-0033", "later-0034", "later-0035"]
serves: ["G1", "G3", "G4"]
intent: ""
model: "opus"
effort: "high"
model_reason: "Coordinates production migrations, deploy order and a human verification loop across every v1 surface."
touches:
  - "ios/RELEASE-v1.md"
  - "ios/scripts/release-record.mjs"
  - "ios/scripts/release-record.test.mjs"
  - "ios/README.md"
  - "README.md"
labels: ["release", "ios", "verification"]
---

## Context

VISION.md: "A working v1 means an installable app and verified end-to-end saving and listening,
not only designs, research screens or passing backend tests." Everything is built by
later-0023…0035; this task ships it and records **evidence from a physical iPhone**, including the
named Siri App Shortcut while the phone is locked. Production migrations, Vercel deploys, DNS,
Supabase dashboard settings and device checks are human-operated (root `README.md` safety rules);
the worker prepares, triggers what it may (the TestFlight workflow) and records results.

## Scope

**Does**
- `ios/RELEASE-v1.md`: ordered release runbook + verification record.
  - Runbook (human steps, no secret values): apply the new migrations
    (`*_article_extraction.sql`, `*_app_library.sql`) with `supabase db push`; deploy the approved
    commit on Vercel; add `later://auth-callback` to Supabase Auth Redirect URLs; confirm the
    `later-intent-processing` schedule is active; dispatch `ios-testflight` on the release commit;
    install from TestFlight.
  - Verification table, one row per check, columns `check | result (pending/pass/fail) | date |
    build | evidence note (no captured content)`. Rows: magic-link sign-in on device; WhatsApp
    capture still works and appears in Saved; email capture still works; share a Safari article
    via the share sheet; share plain text; an article becomes "Ready to listen" with a real
    duration; a video/social post shows Open original with reason and opens it; a paywalled
    article shows Open original; Listen 10/15/30 plans never exceed the slot and underfill is
    stated; full player play/pause/skip/scrub; lock screen controls; headphone play/pause;
    AirPods removal pauses; airplane-mode playback of a prepared item; resume after app kill;
    "Hey Siri, play Later" on a **locked** phone starts narration; "Play a 15 minute Later" via
    Siri; Done with this removes an item; research console still requires recall before reveal
    for an unexposed capture and excludes an exposed one; sign-out clears data.
- `ios/scripts/release-record.mjs` + test: validates the table (every listed row present, results
  in the allowed set, pass rows have date and build) and, with `--require-all-pass`, fails unless
  every row is `pass`. Its test file also runs `--require-all-pass` against the committed record,
  so the Linux `ios/` check (which runs `node --test ios/scripts/`) is red until every row passes.
- Root `README.md`: a short "iPhone v1" section linking `ios/RELEASE-v1.md` (the v0 runbook stays).

**Procedure (the human loop is part of the task)**
1. Prepare the files above; dispatch `ios-testflight` on the release commit; note the build.
2. Set this task `blocked` with `blocked_reason` containing "not machine-checkable: awaiting Dan's
   physical-device verification of build N" and a `decision` ask listing the runbook link and the
   rows (Recommend: run them in order; report pass/fail per row in the task or PR).
3. When results arrive (task `notes` or PR comment from Dan), record them; any `fail` becomes a
   `follow-up` ask naming the row, and the release is not complete. With all `pass`, open the PR.

**Does not**
- Run production migrations, change Vercel/Supabase/DNS settings, or operate Dan's phone.
- Record captured content, analysis results or secrets in the record.

## Acceptance criteria

- [ ] Given the record, then every required row exists with an allowed result and pass rows carry
      date and build — `ios/scripts/release-record.test.mjs`.
- [ ] Given the merge commit, then every v1 check, including locked-device Siri, is recorded as
      passed on a TestFlight build — `ios/scripts/release-record.test.mjs :: every v1 check is
      recorded as passed` (runs in the Flow `ios/` source-root check).
- [ ] Given the release commit, then `ios-ci`, the Flow gate and `ios-testflight` are green — runs
      linked in the PR.

## Definition of done (inherited — do not edit)

Every criterion has a proving test (qa check passes) · security check no high/critical, or
visibly skipped as out of its trigger paths · code-review check blocking items resolved ·
build + lint + test pass · coverage ≥ `coverage_min` (a floor, not the gate) · PR open, task
linked, criteria checklist ticked with the proving test named.

The first three are **checks on the PR**, not subagents the worker runs — it does not certify
its own work. Build, lint, test and coverage are the worker's, and are owed before the PR opens.

## Notes / open questions

- `linux-check.sh` is not edited here: it already runs every `node --test` file in `ios/scripts/`.
