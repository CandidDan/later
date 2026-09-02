# Project protocol — Claude Code

The protocol is not in this file. It lives in one place, `.flow/PROTOCOL.md`, and every agent
that works this repo reads that same copy. This file is the Claude Code entry point to it.

The next line is a Claude Code **import**, not a mention: Claude Code expands `@`-prefixed paths
and loads the target into context at session start, so the protocol arrives in full every session.
Leave it outside backticks and outside code fences — import parsing skips both, and a pointer that
silently does not resolve is worse than no pointer at all.

@.flow/PROTOCOL.md

<!--
Maintainer notes (stripped before this file reaches context, so they cost no tokens):

  * The import path is relative to THIS file, so it stays correct wherever the repo is checked
    out. Claude Code follows imports up to four hops deep; this is one.
  * Do not paste the protocol back into this file. Two copies drift, and the copy an agent
    happens to read stops being the one anyone maintains. Edit `.flow/PROTOCOL.md` instead.
  * `AGENTS.md` points at the same file with a plain-English instruction, because the AGENTS.md
    convention defines no import mechanism. One protocol, two doorways.
  * To confirm the import resolved in a live session, run `/context` and look for
    `.flow/PROTOCOL.md` under **Memory files**.
-->

## Project notes

Everything below is *this project's* context — the things a fresh session cannot derive from the
codebase. It is deliberately separate from the protocol above: the protocol is identical in every
Flow repo, these notes are not.

Keep this file well under **25k characters** (`wc -c CLAUDE.md`). The protocol no longer counts
against that budget, so the whole allowance is available for real project knowledge.

<!-- Replace this list when you adopt Flow. INIT.md and RETROFIT.md both walk you through it. -->

- **What this project is:** _one or two lines — what it does and who for._
- **Stack and layout:** _where the code lives, and anything surprising about how it is organised._
- **Local commands:** _how to run it, beyond the five gate commands in `.flow/config.yml`._
- **Conventions that differ from the defaults:** _the corrections you would otherwise retype._
- **Scars:** _the mistakes that have already been made here once._
