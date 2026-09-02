---
name: task-writer
description: Turn a human's direction into well-formed, ready-to-work task files in .flow/tasks/. Use this whenever the orchestrator (a Cowork session) is decomposing a goal, feature, or piece of direction into work for Claude Code — i.e. any time you're about to create or edit a task, write a backlog, "break this down", "spec this out", or plan what Code should build next. A task is only `ready` when it could be handed to a fresh session with zero further questions; this skill enforces that bar.
---

# task-writer

The orchestrator's single most important output is not "a task" — it's a task that is
**ready**: one a fresh Claude Code session can complete without coming back to ask a
question. Under-specified tasks are exactly where autonomous work stalls and bounces back
to the human. This skill is the discipline that prevents that.

## Where authority sits
The human decides *what matters* (priority, direction) — never invent priorities. You
decide *decomposition* — how a goal becomes a sequence of ready tasks. If a goal is
ambiguous about intent, ask the human one sharp question; if it's only ambiguous about
implementation, that's yours to specify.

## Procedure
1. Read `.flow/tasks/_TEMPLATE.md` (the canonical shape), `.flow/config.yml` (the project's
   id prefix lives in `project.name`) and `VISION.md` at the repo root (the goals a task can
   serve). If there is no `VISION.md`, say so to the human in your first reply — the vision layer
   is inactive, every task you write is unanchored, and the fix is the **vision-writer** skill.
   Don't go quiet about it and don't stall on it: write the tasks, but tell them.
2. Decompose the direction into the smallest tasks that each deliver one observable outcome.
   Prefer several small ready tasks over one large vague one. A task a session can finish in a
   focused sitting is the right grain.
3. For each task, write a file `NNNN-slug.md` with full frontmatter and body. Allocate the next
   id number; set `status: ready`, `priority` (from the human's signal, default 3), `created`.
4. **Acceptance criteria are the work.** Each must be observable and testable, phrased
   given/when/then where it helps. If you can't write a test for a criterion, it's not a
   criterion yet — sharpen it. The worker writes one test per criterion, so vague criteria
   produce vague tests and a failed gate.
5. **Name the goal, once the criteria exist.** With the acceptance criteria written you know what
   the task actually delivers, so now set `serves` to the `VISION.md` goal ids it advances (`G1`,
   `["G1", "G3"]`) — not before, or you are anchoring an intention rather than a deliverable.
   A task you cannot assign a goal to is exactly one of three things, and naming which is the
   work — reaching for the nearest plausible id is the one move that destroys the field's value,
   because it makes drift look anchored:
   - **maintenance** — repo, infra or protocol health no product goal names. Use the reserved id
     `maintenance`; it always resolves and is never declared in `VISION.md`.
   - **the vision is missing a goal** — the work matters and the vision has moved on without
     being updated. Amend `VISION.md` first (vision-writer, branch + PR), then serve the new id.
   - **drift being born** — nothing in the vision wants this. Don't write the task; put the
     question back to the human, in one line, naming what it would serve if anything.
6. State scope boundaries explicitly — what the task does NOT touch. This is what stops scope creep.
7. Sequence: if task B depends on A, note it and leave B at lower priority or a `blocked` note
   until A lands. Keep a queue of `ready` tasks so the worker never runs dry.

## Triaging the inbox (GitHub Issues -> ready tasks)
GitHub Issues are the **capture inbox**: zero-friction logging of bugs and ideas from anywhere,
with whatever context existed at the moment of capture. They are never worked directly, and
nothing enters `.flow/tasks/` un-approved — that's what keeps "ready means ready" trustworthy.
The sweep (run by the `flow-triage` routine, or you on demand) processes each open issue through
three lanes:

- **Propose** (default): draft a complete ready-task spec — full template shape (`serves`
  included, resolved against `VISION.md` the same way step 5 does it), readiness bar applied, the
  issue is raw material not a spec — and post it **as a comment on the issue**,
  labelling the issue `proposed`. Do not create a task file. The human approves by flipping the
  label to `approved` (a one-tap act, from anywhere); the next sweep converts.
- **Convert**: for issues labelled `approved`, create the ready task file (next id, `issue:` set
  to the issue url, commit to `main`), and swap the label to `triaged`. Close the issue when the
  task's PR merges.
- **Auto-ok**: issues the human has labelled `auto-ok` (a pre-authorised policy lane for the
  genuinely mechanical — typos, dep bumps) skip the proposal wait: convert directly. The human's
  authority is exercised per-lane here, not per-item — never apply `auto-ok` yourself.

Not worth doing? Close it with one line saying why — and "no goal serves it" is a first-class
reason to cite, not a cop-out: an issue that resolves to no `VISION.md` goal and is not
`maintenance` is the vision doing its job at the inbox. Unclear intent? Ask the question in an issue
comment rather than proposing a guess. Untouched issues are counted by the flightdeck as queue
debt, so capture never silently rots. Never copy an issue into a task verbatim — "3 trust-busting
bugs in checkout" is capture; a ready task names the behaviour, the boundary, and the criteria
that prove the fix.

## The readiness test (apply to every task before saving)
Ask: *could I hand this to a brand-new session, with no other context, and would it produce
the right thing without asking me anything?* If no — what would it ask? Answer that in the
task. Repeat until the answer is yes. Only then is `status: ready` honest.

Then ask the same question one altitude up: *could that fresh session say, from the task alone,
which goal the work serves?* If the answer needs anything you happen to know and didn't write
down, the anchor is in your head rather than in the store — and it dies with the session.

## Pre-flight (run before you save a batch)
These are the misses that *read* fine but bounce a task downstream — they're mechanical, so check
them mechanically rather than trusting a plausible-sounding narrative:

1. **`touches` is complete.** List every file the *scope* says this task will change, and confirm
   each is matched by a `touches` glob. A file named in the scope but absent from `touches` trips
   `touches-guard` and blocks the PR — it is the single most common cause of a bounced/blocked task.
2. **"Parallel-safe" is proven, not asserted.** Before calling two tasks parallel, actually
   intersect their `touches` lists. If they share *any* path — a classic one is two tasks both
   editing the same page/router to mount into it — they are NOT parallel: sequence them, or
   restructure so each owns a distinct file. Never write "no overlap" you haven't checked. ("Different
   component directory" is not the same as "disjoint touches" — the shared mount file is the trap.)
3. **`serves` resolves.** For each entry, either it is the literal `maintenance` or `VISION.md`
   declares it under `## Goals` — check the id against the file, don't recall it. An entry that
   resolves to a **non-goal** or to a goal under `## Retired` is a finding, not a typo: the task
   is wrong or the vision has moved, and either way it is a sentence to the human. And if a batch
   is *mostly* `maintenance`, say so before you save — legitimate for a hardening sprint, and the
   clearest early signal of drift when it isn't.
4. **Stays on the store plane.** A task only commits to `main` (the store). Code and content
   changes — *including* docs like a synopsis or README — are the worker's branch+PR, never a direct
   orchestrator edit to `main`. If something needs a doc changed, that's a task, not a side-edit.

Then run `node .flow/bin/flow-doctor.mjs`: it computes `touches` overlap across the live set and
resolves every `serves` against `VISION.md`, so a false "parallel-safe" or an unresolvable goal id
surfaces before any worker claims. The doctor owns those rules — don't restate them here, and
don't argue with them. It is the backstop, not the method: the checklist above is how you avoid
writing the problem in the first place.

## Don't
- Don't bundle multiple outcomes into one task to "save files." Split them.
- Don't write implementation steps as if you're the worker — specify the *what* and the
  *acceptance*, leave the *how* to the worker unless a specific approach is genuinely required.
- Don't set `done`/`in_review` — those are the worker's and the merge's transitions.
- Don't retrofit `serves` onto tasks that are already `in_progress`, `in_review`, `done` or
  `blocked`. The field records the goal a task was *written* to advance; back-filling it is
  inventing a history in which the anchor existed, which is exactly the drift the layer exists
  to make visible. flow-doctor treats a non-`ready` task's unresolvable `serves` as a warning
  for the same reason. New tasks carry it; finished ones stay as they were.
- Don't leave a real open decision inside a `ready` task. Decide it (or ask the human), then write it.

After writing or changing tasks, regenerate the board with the **board-builder** skill so the
human's view reflects the new state.
