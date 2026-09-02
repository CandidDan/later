# Agent instructions

## Read the protocol first — it is not in this file

**Before you do anything else, open and read `.flow/PROTOCOL.md` in full.**

That file is the contract you work under: the task store, the status lifecycle, the concurrency
rules, the loop you run, the gate a PR must pass, and the hard rules. It is not optional context
and it is not a reference to consult later — a session that skips it will break the rules it has
not read, and the first sign of that is a rejected PR.

The AGENTS.md convention defines no import or include mechanism, so this pointer is a plain
instruction rather than a directive your host expands. Acting on it is your responsibility. If
you cannot read `.flow/PROTOCOL.md`, stop and say so rather than proceeding without it.

There is exactly **one** copy of the protocol in this repo. `CLAUDE.md` imports the same file
for Claude Code. Do not copy the protocol into this file, and do not follow a stale copy of it
from anywhere else.

## Project notes

Everything below is *this project's* context — the things a fresh session cannot derive from the
codebase. The protocol above is identical in every Flow repo; these notes are not.

<!-- Replace this list when you adopt Flow. INIT.md and RETROFIT.md both walk you through it. -->

- **What this project is:** _one or two lines — what it does and who for._
- **Stack and layout:** _where the code lives, and anything surprising about how it is organised._
- **Local commands:** _how to run it, beyond the five gate commands in `.flow/config.yml`._
- **Conventions that differ from the defaults:** _the corrections you would otherwise retype._
- **Scars:** _the mistakes that have already been made here once._
