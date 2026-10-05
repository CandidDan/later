---
name: show-me
description: Explain with compact visuals instead of prose. Use for every response to the human, every end-of-run summary and every PR description — whenever you are about to write more than a few sentences, or explain anything with structure (a flow, a hierarchy, a comparison, a change, a state machine).
---

# show-me

Humans scan pictures faster than they read paragraphs. Prose is the fallback, not the default.

## Rules

1. **Fewest words that carry the point.** Cut, then cut again.
2. **No preamble, recap, hedging or drama.** No "Great question", no "Let me…", no restating the
   ask, no "this is the critical insight". Start with the answer.
3. **Structure → visual.** If it has rows, steps, levels, branches or a before/after, draw it.
4. **One visual per idea.** Don't follow a table with a paragraph that says the same thing.
5. **Prose only for the why** — one or two sentences a visual can't carry.
6. **Terse is not cryptic.** Plain words, full sentences, jargon explained or cut. Short and
   clear beats short and puzzling.

## Pick the format

| You are explaining… | Use |
|---|---|
| options, comparisons, results, status | table |
| files changed, layout, ownership | tree |
| control flow, who calls whom | call stack |
| states, sequences, pipelines | mermaid |
| what changed | diff |
| an algorithm | pseudocode |
| data shape, an interface | type signature |
| UI | ASCII or HTML mockup |

### Table

| Check | Before | After |
|---|---|---|
| lint | 4 files | all tracked `.mjs` |

### Tree

```
.flow/bin/
├── pick-task.mjs      chooses next ready task
└── flow-state.mjs     reconciles store with PRs
```

### Call stack

```
flow-open-pr.yml
└─ decideOpenPr(task, branch)
   ├─ parseTaskId(branch)
   └─ gh pr create   ← only if none open
```

### Mermaid

```mermaid
stateDiagram-v2
  ready --> in_progress: claim
  in_progress --> in_review: PR opened
  in_review --> done: merged
```

### Diff

```diff
- if (status === "in_progress") check(task)
+ if (status === "done" || task.id === ownId) check(task)
```

### Pseudocode

```
for task in store:
  if task.done or task.id == own: require fragment
```

### Type signature

```ts
type Task = { id: string; status: Status; touches: string[] }
```

## PR description

In this order, nothing else:

1. **TL;DR** — one line.
2. **The change, shown** — one visual (diff, tree, table or mermaid).
3. **Criteria** — checklist, each ticked with its proving test.
4. **To-dos for the human** — numbered; omit if none.

## Anti-patterns

Too much:

- Wall of text with a TL;DR bolted on the end.
- A TL;DR on a reply short enough to be its own summary (under ~15 lines).
- Dramatic framing, restating the question, recapping what was just shown.
- Headers over one-line sections; bullet lists that are really a table.
- Explaining a diff in words next to the diff.

Too little:

- Dropped articles and verbs ("fixed, pushed, PR up").
- Unexplained jargon, task ids or internal names the reader hasn't seen.
- Arrow chains (`a → b → c`) standing in for a sentence that explains why.
