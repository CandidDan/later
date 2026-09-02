---
name: vision-writer
description: Interview a human into a one-page VISION.md — the drift anchor that every task's `serves:` resolves against — and amend it when direction genuinely changes. Use whenever a repo has no VISION.md and needs one, when adopting Flow into an existing codebase, or when the human says a goal has changed, a non-goal is now a goal, or "this isn't what I wanted any more". Goals and non-goals are the human's to declare; this skill extracts them, it never invents them.
---

# vision-writer

`serves:` has to resolve against something. `VISION.md` is that something: one page, at the
repo root, naming the three-to-six outcomes that define success and the non-goals that define
rejection. flow-doctor fails a `ready` task whose `serves` names no goal declared there.

The failure mode this skill exists to prevent is a vision written by **reading the codebase**.
That document describes the drift instead of catching it — the layer then reports "on course"
forever, and has failed while looking exactly like it succeeded. So this is an **extraction**
tool, not an authoring tool. You ask; the human answers; you write down what they meant.

## Where authority sits
The human owns **every goal and every non-goal** — their wording, their priority, and the
decision to retire one. You own the *shape*: the heading form, the id discipline, the change
log, and whether an answer is sharp enough to reject something. If a goal is vague, ask one more
question; never soften a non-goal to keep options open, and never fill a gap with a plausible
guess. An invented goal is worse than a missing one: the missing one is visibly missing.

## Create mode — the interview

Ask these in order. One question at a time; the answers build on each other. Write nothing until
you have been through all six.

1. **What is this, and who is it for?** In their words, not a feature list. Push until you have
   a sentence that would mean something to someone who has never seen the repo.
2. **Record the audience as a decision, not an assumption.** Solo tool, team tool, or product —
   make them pick one out loud. Then make them decide the multi-user question separately and
   explicitly: is a second user **preserved** (kept possible, deliberately not built for) or
   **foreclosed** (ruled out, and the design may assume one user)? Write the answer into the
   purpose paragraph in those words. Both halves are required — an audience nobody decided is an
   audience every future session infers differently, and each inference is defensible.
3. **What are the three to six outcomes that define success?** Each one must be an outcome that
   could *fail*, not a feature that could ship. Ask what they would observe if it were working;
   that answer becomes the goal's *Progress looks like:* line. Fewer than three is usually one
   goal wearing a hat; more than six is a backlog.
4. **What is this deliberately NOT?** Push here, hard, and more than once — humans reliably
   under-supply non-goals, and the non-goals are the half that does the rejecting. Ask for the
   *tempting adjacent thing*, not the absurd one: "should this ever become a hosted service / a
   product / a second store?" A non-goal nobody was tempted by is decoration. Capture the
   **reason** with each one, because the reason is what rejects the next idea too.
5. **What would "off course" look like in six weeks?** Concrete: a feature that would make them
   wince, a direction that would feel like a different project. This is the sharpest source of
   non-goals, and it is the question that most often changes a goal they had already given you.
6. **Read the draft back and apply the rejection test.** Ask: *could a stranger, holding only
   this purpose paragraph and these non-goals, correctly reject a plausible-but-wrong feature
   idea?* Try one on them out loud. If the document does not reject it, the purpose paragraph or
   the non-goals are too soft — sharpen them and test again before you write the file.

**Retrofitting onto an existing codebase: write the vision the human intends, not a description
of what the repo currently is.** Do not read the code to derive goals, and do not reverse-engineer
a goal from a feature that already exists. When the repo and the intent disagree, that gap is the
first real finding — record the intent, and say plainly which existing behaviour now looks like
drift. A vision that matches the code perfectly on day one has measured nothing.

Then write `VISION.md` at the repo root, using the shape in the shipped template: purpose
paragraph, `### G<n> — <title>` goals, `### NG<n> — <title>` non-goals, a `## Retired` section
(`*None yet.*`), and a change-log table whose first row is dated and says why it was written now.

## Amend mode — when direction genuinely changes

A vision that never changes is being ignored, not obeyed. Amending is normal; amending *quietly*
is the thing that isn't. Every rule here exists so a reader a year from now can tell the two apart.

- **Ids are append-only. Never renumber, never reuse.** A merged task's `serves: ["G2"]` must
  still mean the same thing today. The next new goal takes the next unused number — never a freed
  one — so a retired id stays reserved forever.
- **Retiring is a move, not a delete.** Move the heading under `## Retired`, keep its id
  unchanged, and add a one-line reason with the date. Tasks still pointing at it then surface as
  warnings, which is the signal you want rather than an unknown-id failure.
- **Promoting a non-goal is not an edit in place.** Retire the `NG<n>` id under `## Retired` with
  the reason, and add a *new* `G<n>` id for the goal. Rewriting the NG heading into a G heading
  erases the fact that the position reversed — which is exactly the fact worth keeping.
- **Every material edit appends a change-log row** — date, what changed, and why. A wording fix
  needs no row; a changed, added, retired or promoted goal always does. The row is the history;
  the PR review is the touchpoint.
- Confirm each change with the human in their own words before writing it. An amendment inferred
  from a conversation about a task is drift with better manners.

## Output — always a branch and a PR

`VISION.md` lives on the code plane, not the store plane, precisely so the PR machinery reviews it.

1. Branch off latest `main` (`vision/<short-slug>`, or stay on the branch your harness handed you).
2. Write or edit `VISION.md` there — **never commit it directly to `main`**, and never bundle it
   into a feature PR where it would be reviewed as a diff nobody read.
3. Open a PR titled **`[vision] <what changed>`**. In the description: what changed, why now, and
   for an amendment, which ids were retired or added and which tasks now `serves` a retired id.
4. Stop. The human approves the merge — that approval *is* the act that makes this the vision.

This is the whole reason evolution is mechanically distinguishable from drift: divergence with a
reviewed vision change is evolution; divergence without one is drift. A direct commit to `main`
destroys that distinction for every future audit, not just this one.

## Don't
- Don't derive a goal from the code, a task file, a README or a backlog. Ask the human.
- Don't accept a non-goal list that only contains things nobody wanted. Push for the tempting one.
- Don't soften a non-goal to keep an option open — "we might one day" is not a non-goal, it is
  the absence of one. If the human genuinely hasn't decided, say so and ask them to decide.
- Don't renumber, reuse or silently reword an id. Don't delete a retired goal to tidy the page.
- Don't exceed one page. A vision nobody re-reads is not an anchor; if it won't fit, the goals
  are tasks.

After `VISION.md` lands, run `node .flow/bin/flow-doctor.mjs`: it reports any `ready` task whose
`serves` no longer resolves, and any goal heading it could not read.
