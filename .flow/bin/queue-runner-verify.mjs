#!/usr/bin/env node
// queue-runner-verify.mjs — fail the queue-runner job when a worker produced no verifiable outcome.
//
// Observed on CandidDan/write (issue #33): a worker ran 57/120 turns, the SDK result said
// `is_error: false`, and the queue-runner job concluded SUCCESS — but no branch was pushed, no
// PR opened, no `blocked` transition made. The task sat falsely `in_progress` until the
// flow-recover sweep reset it, and the Actions history showed a green run for ~$4-5 of nothing.
// Repeated on the same task, the pattern burns cost silently instead of surfacing.
//
// flow-recover already heals the *task state*; this module closes the narrower observability
// hole: the job's own verdict. The protocol's definition of a finished run is one of exactly
// three outcomes, and the job must re-derive them from the remote rather than take the
// worker's exit code at its word:
//
//   1. a `flow/<id>-*` branch exists on origin, ahead of origin/main;
//   2. an open PR exists for that branch / task id;
//   3. the task on main is `blocked` with a non-empty `blocked_reason`.
//
// A `notes` entry alone is DELIBERATELY not a passing outcome. The worker prompt already says
// pushing nothing "costs the whole run" even with a note left behind: a note helps the next
// worker start warmer, but it is not itself a finished or blocked result, and letting it
// silence this check would green-light exactly the runs it exists to expose.
//
// This module is the pure decision; the git/gh I/O (does the branch exist, is it ahead, is
// there an open PR) is a thin shell in `_flow-queue-runner.yml` around `runVerify`, the same
// split flow-recover's `classifyStranded` and flow-open-pr's `decideOpenPr` use.
//
//   node .flow/bin/queue-runner-verify.mjs --task-id CAN-50 \
//        --branch-exists 1 --ahead 3 --has-open-pr 0     # exit 0: branch pushed, work survives
//   node .flow/bin/queue-runner-verify.mjs --task-id CAN-50 \
//        --branch-exists 0 --ahead 0 --has-open-pr 0     # exit 1: nothing verifiable happened
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
// CLI block below silently never runs — no output, exit 0, nothing to debug. For a verifier
// that means the job takes the worker's word after all: it fails OPEN, the exact failure mode
// this file exists to remove. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// Pure decision. Given the observed facts, return { ok, outcome, message }:
//   ok: true   outcome: "branch-pushed" | "pr-open" | "blocked"  — the run left something real
//   ok: false  outcome: "none"                                   — the job must fail
// The failure message names the task id and each of the three outcomes checked, with what was
// actually observed for each — the run summary is the only artefact a human sees, so it has to
// carry the whole diagnosis.
export function verifyOutcome({
  taskId = "",
  branchExists = false,
  aheadOfBase = false,
  hasOpenPr = false,
  taskFound = true,
  status = "",
  blockedReason = "",
} = {}) {
  const blocked = taskFound && status === "blocked" && String(blockedReason).trim() !== "";

  if (branchExists && aheadOfBase) {
    return {
      ok: true, outcome: "branch-pushed",
      message: `queue-runner-verify: OK — a flow/${taskId}-* branch is on origin ahead of main; ` +
        `flow-recover or flow-open-pr can carry the work forward.`,
    };
  }
  if (hasOpenPr) {
    return {
      ok: true, outcome: "pr-open",
      message: `queue-runner-verify: OK — an open PR exists for ${taskId}; the loop reached its hand-off.`,
    };
  }
  if (blocked) {
    return {
      ok: true, outcome: "blocked",
      message: `queue-runner-verify: OK — ${taskId} is blocked with a recorded blocked_reason; ` +
        `stopping on a real decision is a legitimate outcome, not a wasted run.`,
    };
  }

  const branchLine = branchExists
    ? "found on origin but NOT ahead of main (no commits to recover)"
    : "not found on origin";
  const statusLine = taskFound
    ? (status === "blocked"
        ? `status "blocked" but blocked_reason is empty — a block with no reason is not a decision on the record`
        : `status "${status}", not "blocked"`)
    : "task file not found on main";
  return {
    ok: false, outcome: "none",
    message:
      `queue-runner-verify: FAIL — no verifiable outcome for ${taskId}. Checked for:\n` +
      `  1. a flow/${taskId}-* branch on origin ahead of main -> ${branchLine}\n` +
      `  2. an open PR for that branch / task id -> none\n` +
      `  3. task "blocked" on main with a non-empty blocked_reason -> ${statusLine}\n` +
      `A \`notes\` entry alone is deliberately not a passing outcome. The worker may have ` +
      `exited cleanly, but nothing this run produced can be recovered or reviewed, so the job ` +
      `fails rather than reporting success it did not earn.`,
  };
}

// Thin file read: the status + blocked_reason of the task whose frontmatter id matches — the
// same store walk flow-open-pr's readTaskTitle does. Returns { found:false } when no task file
// matches (or the directory is unreadable): the caller treats that as "outcome 3 cannot hold",
// never as a crash — a verifier that errors out reports nothing to the run summary.
export function readTaskState(tasksDir, id) {
  let names;
  try {
    names = readdirSync(tasksDir);
  } catch {
    return { found: false, status: "", blockedReason: "" };
  }
  for (const name of names) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const src = readFileSync(join(tasksDir, name), "utf8");
    const idM = src.match(/^id:\s*"?([^"\n]+)"?/m);
    if (!idM || idM[1].trim() !== id) continue;
    const statusM = src.match(/^status:\s*"?([^"\n]*?)"?\s*$/m);
    const reasonM = src.match(/^blocked_reason:\s*"?(.*?)"?\s*$/m);
    return {
      found: true,
      status: statusM ? statusM[1].trim() : "",
      blockedReason: reasonM ? reasonM[1].trim() : "",
    };
  }
  return { found: false, status: "", blockedReason: "" };
}

// The IO-assembled entry both CLI shells share: read the task's state from the store, fold in
// the git/gh facts the workflow observed, return the verdict. The store location is a required
// argument — the template deliberately resolves nothing global, so an adapter (canonical's
// `.flow/bin/queue-runner-verify.mjs`) can pin its own store instead of this file's fixture.
export function runVerify({ tasksDir, taskId, branchExists, aheadOfBase, hasOpenPr }) {
  const state = readTaskState(tasksDir, taskId);
  return verifyOutcome({
    taskId,
    branchExists,
    aheadOfBase,
    hasOpenPr,
    taskFound: state.found,
    status: state.status,
    blockedReason: state.blockedReason,
  });
}

// ── CLI plumbing ── shared with the canonical adapter, so the two shells cannot drift.
export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// Verdict -> process outcome. A pass prints to stdout and exits 0; a fail prints to stderr and
// exits 1 — the non-zero exit is what fails the queue-runner job, the text is the diagnosis.
export function reportAndExit(verdict, { log = console.log, error = console.error, exit = process.exit } = {}) {
  if (verdict.ok) { log(verdict.message); exit(0); }
  else { error(verdict.message); exit(1); }
}

// Flags -> runVerify inputs. Exported so both CLI blocks (and their tests) share one mapping.
export function verifyArgsFromFlags(flags, tasksDir) {
  return {
    tasksDir,
    taskId: String(flags["task-id"] || ""),
    branchExists: Number(flags["branch-exists"] || 0) > 0,
    aheadOfBase: Number(flags.ahead || 0) > 0,
    hasOpenPr: Number(flags["has-open-pr"] || 0) > 0,
  };
}

// ── CLI ── In an adopting repo this file is copied to `.flow/bin/`, so resolving the store
// relative to this file's own location lands on that repo's real `.flow/tasks/`. In canonical
// this default would land on the template's fixture store — which is why canonical runs its
// adapter, never this file directly.
if (__isMain) {
  const flags = parseFlags(process.argv.slice(2));
  const tasksDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "tasks");
  reportAndExit(runVerify(verifyArgsFromFlags(flags, tasksDir)));
}
