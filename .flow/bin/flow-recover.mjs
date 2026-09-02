#!/usr/bin/env node
// flow-recover.mjs — self-heal tasks stranded `in_progress` with no PR.
//
// CAN-50 makes a worker stopping short of `gh pr create` less likely by opening the PR on
// branch push. But prevention can never be total: a process can die at any point — crash,
// timeout, network — between the push and the PR. Today that leaves a task `in_progress`
// with no PR forever: it can't be re-picked (the claim is taken) and nothing resolves it
// until a human notices. That single point of manual rescue is the exact thing the loop is
// meant to remove. A stranded task is a precisely detectable state, so it can be precisely
// healed: this is the recovery half (CAN-50 is prevention).
//
// This module is the pure classifier; the git/gh I/O (does the branch exist, is it ahead of
// base, is there an open PR, how old is it) is a thin shell in the workflow around
// `classifyStranded`. Recovery lives in its OWN script — deliberately NOT in flow-doctor.mjs.
//
//   node .flow/bin/flow-recover.mjs classify --status in_progress \
//        --branch-exists 1 --ahead 1 --has-open-pr 0 --age 90 --threshold 75   -> "reopen-pr"
//   node .flow/bin/flow-recover.mjs list-in-progress    # prints "<id>\t<started>" per task
//   node .flow/bin/flow-recover.mjs reset CAN-51        # prints the board-edits JSON to reset it
//
// Zero dependencies (Node >= 18).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED.
// When the script is reached through a symlink they differ, the comparison is false, and the
// CLI block below silently never runs — no output, exit 0, nothing to debug. macOS hits this
// routinely because os.tmpdir() (/var/folders/...) is a symlink to /private/var/folders/...,
// and any symlinked checkout or bind-mount does the same. For touches-guard that means the
// scope check silently does not run and the gate goes green: it fails OPEN, which is the
// wrong direction for a guard. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------
// Conservative default: don't rescue a task until it has gone this long without resolving to
// a PR. Long enough that a worker mid-loop (build + gate can run many minutes) is never cut
// off; short enough that a genuinely dead session self-heals within the hour. Tune freely.
export const DEFAULT_THRESHOLD_MINUTES = 75;

// Pure classifier. Given a task and the observed git/gh facts, return exactly one of:
//   "ok"             — leave it alone (not in_progress, has a PR, or too young to judge)
//   "reopen-pr"      — work was pushed (branch exists, ahead of base) but no PR opened
//   "reset-to-ready" — no branch / no commits to recover; clear the claim so it's re-pickable
// Conservative by construction: only `in_progress` is ever swept, an open PR is never
// disturbed, and nothing happens before the staleness threshold.
export function classifyStranded(task, state, thresholdMinutes = DEFAULT_THRESHOLD_MINUTES) {
  const { branchExists = false, hasOpenPr = false, aheadOfBase = false, ageMinutes = 0 } = state || {};
  if (!task || task.status !== "in_progress") return "ok"; // only in_progress is swept
  if (hasOpenPr) return "ok";                              // progressing — never disturbed
  if (ageMinutes < thresholdMinutes) return "ok";         // no premature rescue
  if (branchExists && aheadOfBase) return "reopen-pr";    // pushed work, PR just never opened
  return "reset-to-ready";                                // nothing to recover -> re-claimable
}

// The board-edit that resets a stranded task so it can be claimed again. Mirrors the
// close-unmerged reset in flow-status.yml exactly: clear owner/branch/pr and go back to ready.
// `started` is intentionally left as-is — apply-board-edits.mjs (the sanctioned writer, which
// this task calls but must not modify) only patches status/priority/owner/branch/pr, and a
// stale `started` on a ready task is harmless (flow-doctor keys re-claimability off `owner`,
// which we DO clear). Applied via apply-board-edits.mjs as a commit to main — never hand-edited.
export function buildResetEdit(id) {
  return { id, status: "ready", owner: "", branch: "", pr: "" };
}

// Whole minutes elapsed between a timestamp (ISO datetime, or a date-only `started` like
// "2026-06-18") and `now`. Negative clamps to 0. Returns null for an unparseable/empty value
// so the caller can decide (a task with no `started` shouldn't be aged out on a bad parse).
//
// A date-only value is anchored to the END of that day (23:59:59.999Z), NOT its midnight.
// `Date.parse("2026-06-18")` gives 00:00Z, which makes a task claimed at 09:23Z read as 563
// minutes old at the instant of the claim — already past the 75-minute strand threshold. The
// sweep then resets a live claim back to `ready` about a minute after it is taken, the next
// queue-runner re-picks the same task from zero, and no run's work carries forward. Anchoring
// to end-of-day errs the only safe way for a destructive sweep: it can delay a genuine
// recovery by up to a day, but it can never cancel a claim that is still being worked.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function minutesSince(when, now = Date.now()) {
  if (!when) return null;
  const t = Date.parse(DATE_ONLY.test(when) ? `${when}T23:59:59.999Z` : when);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60000));
}

// Parse the few frontmatter fields the sweep needs from a task file's text.
function parseTask(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].split("#")[0].trim().replace(/^"(.*)"$/, "$1") : "";
  };
  const id = get("id");
  if (!id) return null;
  return { id, status: get("status"), started: get("started"), branch: get("branch") };
}

// Read every task file in a tasks dir (skips _TEMPLATE.md and non-.md).
export function readTasks(tasksDir) {
  const out = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (t) out.push(t);
  }
  return out;
}

// ── CLI ── three thin subcommands; the workflow supplies all git/gh facts. Always exits 0.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (__isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tasksDir = join(flowDir, "tasks");

  if (cmd === "classify") {
    const f = parseFlags(rest);
    const decision = classifyStranded(
      { status: f.status },
      {
        branchExists: Number(f["branch-exists"] || 0) > 0,
        hasOpenPr: Number(f["has-open-pr"] || 0) > 0,
        aheadOfBase: Number(f.ahead || 0) > 0,
        ageMinutes: Number(f.age || 0),
      },
      f.threshold ? Number(f.threshold) : DEFAULT_THRESHOLD_MINUTES,
    );
    process.stdout.write(decision + "\n");
  } else if (cmd === "list-in-progress") {
    for (const t of readTasks(tasksDir)) {
      if (t.status === "in_progress") process.stdout.write(`${t.id}\t${t.started}\n`);
    }
  } else if (cmd === "reset") {
    const id = rest[0];
    if (id) process.stdout.write(JSON.stringify({ updates: [buildResetEdit(id)] }) + "\n");
  } else {
    process.stderr.write("usage: flow-recover.mjs <classify|list-in-progress|reset> …\n");
  }
  process.exit(0);
}
