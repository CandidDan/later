---
name: board-builder
description: Regenerate the .flow/board.html control surface from the task files in .flow/tasks/. Use whenever task state changes — a task is created, claimed, moved, handed to review, blocked, or merged — so the human's glance-surface stays current. Also use when the human asks to "update the board", "show me where things are", or wants the project status as something they can actually look at rather than scroll past.
---

# board-builder

The board is the human's seat in the loop: the thing they *look at* to validate, and
*manipulate* when they act as worker. It is a view, never a source of truth. The truth is
the task files; the board renders them and writes edits back through a committed script.
Data underneath, HTML on top.

## The pattern (do not break it)
- **Read** every `.flow/tasks/*.md` (skip `_TEMPLATE.md`). Parse frontmatter into a task list.
- **Render** them into the board's embedded `TASKS` array — the board is one self-contained
  HTML file with the data baked into a `<script>` block. No build step, no fetch, opens on a
  double-click or as a shareable link.
- **Write back (no clipboard)** — the board's edit actions (drag a card to a new column, bump
  a priority) never write task files directly. "Apply edits" produces `.flow/board-edits.json`;
  the committed `.flow/bin/apply-board-edits.mjs` then patches ONLY the `status`/`priority`
  lines of the matching task files. That script is the single canonical writer, so the files
  stay authoritative, the change is a reviewable git diff, and nothing is ever pasted into a
  prompt. Two ways the JSON reaches `.flow/`: the **File System Access API** writes it straight
  in (Chromium-only, and only over http/localhost — not `file://`), otherwise the board falls
  back to a plain **download** that the human drops into `.flow/`. In practice the download path
  is the common one, so the realistic flow is *download → run the script* — still no clipboard,
  just not a silent direct write.

## Live mode vs snapshot
The board has two data paths. **Live** — "Connect store" reads `.flow/tasks/` directly via the
File System Access API (Chromium, not `file://`) and "Refresh" re-reads on demand; no regeneration
needed. **Snapshot** — the embedded `TASKS` array, which is what this skill regenerates. Keep
regenerating the snapshot on state changes anyway: it's what renders on Safari/Firefox, on
`file://` double-clicks, and when the board is shared — live mode is an enhancement, not the
canonical path.

## Procedure
1. Read all task files; build the task objects (id, title, status, priority, project, owner,
   pr, blocked_reason, labels).
2. Open the existing `.flow/board.html`, locate the `const TASKS = [...]` block, and replace
   it with the freshly parsed array. Leave all markup/styles/scripts intact — you are swapping
   data, not redesigning. (If `board.html` doesn't exist yet, create it from the template shape:
   columns ready · in_progress · in_review · blocked · done; draggable cards; a detail panel; the
   apply-edits / download-edits buttons.)
3. Keep it self-contained and offline (no external JS deps; fonts via CDN are fine). No
   localStorage — state is in-memory; persistence is via apply-board-edits.mjs, matching the
   files-are-truth rule.
4. Save. Tell the human it's refreshed and where it is.

## When the human edits on the board
They drag/reprioritise and hit "Apply edits". The board writes `.flow/board-edits.json`; then
`node .flow/bin/apply-board-edits.mjs` patches the matching task files' frontmatter and consumes
the edits file. Regenerate the board afterwards so it reflects the now-canonical state. The
human stayed in the loop, the loop got tighter, and nothing was typed into a prompt that a drag
couldn't express.

## Don't
- Don't hand-edit the board's data and call it state — the files are state.
- Don't add a backend or persistence layer; `apply-board-edits.mjs` is the persistence story.
- Don't let the board write task files directly — only apply-board-edits.mjs writes frontmatter.
- Don't redesign the board on a data refresh; only swap the `TASKS` array.
