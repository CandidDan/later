---
name: flow-compass
description: Audit whether the sum of recently shipped and queued work still serves VISION.md, and file one issue per material divergence. Runs on a weekly schedule (or on demand) via the flow-compass workflow, never inside a worker's own session. Use this skill's procedure whenever you are asked to run the drift audit, check "are we still building the right thing", or review recent tasks against the vision.
---

# flow-compass

The per-PR gate answers "does this diff match its task?" with teeth — enforced, unbypassable.
Nothing answers "does the *sum* of the work still match the vision?" That question is a
judgement, not a mechanical check, so it cannot get the gate's teeth. What it can get is a
reliable cadence and an honest, evidenced hand-off to the person whose judgement it actually is.
That is compass: it reports, on a schedule, into the same inbox every other judgement call goes
through (a GitHub issue). It never corrects.

## The boundary is the whole design

Compass **reports**. It never fixes, never edits `VISION.md`, never edits a task, never commits,
never opens a PR, never changes a line of code. This is not a style preference — it is what stops
an advisory audit from quietly becoming an unreviewed writer the next time someone asks it to
"just fix the obvious ones." The boundary is enforced mechanically, not just stated here: the
`_flow-compass.yml` workflow grants the job `contents: read` and nothing that could write source,
and `.flow/bin/check-workflows.test.mjs` fails the build if that permission is ever raised. Filing
an issue is the entire output surface.

## Procedure

1. **Load the anchor.** Read `VISION.md` at the repo root. If it does not exist, file one issue
   saying the vision layer is inactive (there is nothing to audit against) and stop.
2. **Survey the record**, bounded to the audit window (since the last compass run, or the last
   week if this is the first):
   - recently `done` tasks in `.flow/tasks/`, and their `serves` fields,
   - the current `ready` queue and its `serves` fields,
   - merged PR titles in the window,
   - the codebase's top-level shape (new top-level directories, new dependencies) as a sanity
     check against what the vision says this project is.
3. **Classify divergences.** For each thing the survey turns up, decide which of these it is —
   naming which is the work, not a formality:
   - **Unanchored work** — a task or merged PR with no resolvable `serves`, or `serves` that
     resolves to a goal under a `## Retired` heading.
   - **Starved goals** — a goal in `VISION.md` with no `done` or `ready` task serving it across
     a wide window (the vision names something nothing is moving toward).
   - **Non-goal encroachment** — shipped work that reads as building something `VISION.md`
     explicitly lists as *not* a goal.
   - **`maintenance` share** — the reserved `serves: maintenance` id is legitimate, but a queue
     that is mostly maintenance for a sustained stretch is itself a signal worth a decision.
   - **Vision staleness** — the pattern across several divergences points at the vision having
     moved without being amended, rather than at any one task being wrong.
4. **Apply the calibration bar** (below) to decide what is worth a human's attention.
5. **File.** For each *material* divergence, file one GitHub issue labelled `compass`. Every
   issue must carry:
   - evidence a human can check **from the issue alone** — task ids, PR links, goal ids, no
     "trust me" summaries;
   - a proposed lane: **fix** (do the anchored work), **amend** (the vision should change), or
     **accept** (log it and move on) — your best read, not a demand;
   - nothing else. No code diffs, no task edits, no vision edits attached or implied.
6. **Summarise.** Emit a one-line summary of what was found (or "no material divergence this
   run") so the run is legible without opening every issue.

## Calibration — what counts as material

**Material means a human should spend a decision on it.** Not everything the survey turns up
clears that bar, and filing noise trains the human to stop reading compass issues, which is worse
than under-reporting.

- **Batch trivia into one roll-up issue** rather than filing one issue per minor item — a single
  `maintenance`-tagged task with a slightly thin rationale is not its own issue; a pattern of ten
  of them across a month is one issue with all ten cited as evidence.
- **Don't re-file a finding the human already closed as `accept`.** Check open *and closed*
  `compass` issues before filing — if the same divergence was raised and accepted, only file
  again if it has **materially grown** (a starved goal that was one task behind is different from
  one that is now five; say what changed since the prior issue).
- **When in doubt, file as a question**, not a silent skip and not an asserted verdict. Compass's
  job is to surface the decision, not to have already made it.

## Don't

- Don't commit anything, on any branch, for any reason.
- Don't edit `.flow/tasks/` — not even to add a note. If a task looks unanchored, that's evidence
  in an issue, not a task-file edit.
- Don't edit `VISION.md`. A vision amendment is the human's call, made through `vision-writer` and
  a PR — compass can *propose* "amend" as a lane, it cannot act on it.
- Don't touch any source file. Compass has no code-writing task to do; if you find yourself about
  to write one, stop — that is out of scope by design, not by oversight. The workflow's
  `permissions:` block (`contents: read`) is the mechanical proof this cannot happen even if the
  prompt were ignored.
- Don't judge correctness, test coverage, or scope-vs-`touches`. That is the per-PR gate's
  territory, already enforced there. Compass audits *direction*, never *correctness*.
