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

// ── the failure notice ── the pure renderer `_flow-queue-runner.yml`'s "Explain what happens to
// the claim" step writes to `$GITHUB_STEP_SUMMARY`.
//
// It lives here because it needs exactly the facts the verify step already derived from
// `origin`, and that step used to discard them: they were shell locals, the step carried no
// `id:`, and nothing reached `$GITHUB_OUTPUT`. So the notice printed a two-branch hypothetical
// ("which way it goes depends on what this run managed to push") from a job that knew which way
// it went, and opened with the flat claim "No PR was opened" — which `if: failure()` never
// established, and which a worker that pushes, opens its PR and *then* exits non-zero makes
// false. One decision, one description, one place.
//
// Returns { outcome, markdown }:
//   "pr-open"      an open PR exists -> name it, and never claim that no PR was opened. Takes
//                  precedence over every branch fact, including the contradictory
//                  {no branch, open PR}: a cloud worker can be forced onto a non-`flow/` branch,
//                  which is why the step falls back to matching the `[<id>]` title prefix at all.
//   "branch-ahead" branch on origin with commits -> name it and the count; flow-recover reopens
//                  the PR from it.
//   "branch-stale" branch on origin but not ahead of main -> nothing on it to recover.
//   "nothing"      no branch reached origin -> the task resets to `ready` past the staleness
//                  threshold.
//
// What no outcome may drop, because it is the part that was always right: this job does not
// release the claim, and flow-recover owns that decision. Releasing it from the failure path
// would race a worker that is still finishing.
export function renderClaimNotice({
  taskId = "",
  branch = "",
  branchExists = false,
  ahead = 0,
  hasOpenPr = false,
} = {}) {
  const id = String(taskId);
  const commits = Math.max(0, Number(ahead) || 0);
  // `branchExists` with no name is not a state the workflow can produce, but the renderer is
  // total by design — an unnamed branch still gets described rather than rendered as "`undefined`".
  const branchLabel = branch ? `\`${branch}\`` : `the \`flow/${id}-*\` branch on \`origin\``;

  let outcome;
  let body;
  if (hasOpenPr) {
    outcome = "pr-open";
    const where = branch
      ? `from ${branchLabel}`
      : `titled \`[${id}] …\` (on a branch outside the \`flow/${id}-*\` convention)`;
    body = [
      `**A pull request is open** for \`${id}\`, ${where} — this run did open a PR, and the work`,
      `is on it. The failure above is the job's exit status, not the state of the work: review`,
      `the PR as usual, and read the worker's log for what it hit after opening it.`,
    ];
  } else if (branchExists && commits > 0) {
    outcome = "branch-ahead";
    body = [
      `**No PR is open, but the work is on \`origin\`**: branch ${branchLabel},`,
      `${commits} commit${commits === 1 ? "" : "s"} ahead of \`main\`. **flow-recover** reopens the`,
      `PR from that branch on its next sweep, so the work survives this run.`,
    ];
  } else if (branchExists) {
    outcome = "branch-stale";
    body = [
      `**No PR is open, and the branch carries nothing**: ${branchLabel} is on \`origin\` but is`,
      `not ahead of \`main\`, so there are no commits for flow-recover to reopen a PR from.`,
      `\`${id}\` resets to \`ready\` once its claim passes the staleness threshold, and the next`,
      `queue-runner starts it over from zero.`,
    ];
  } else {
    outcome = "nothing";
    body = [
      `**No PR is open and no branch reached \`origin\`** — this run produced nothing recoverable.`,
      `\`${id}\` resets to \`ready\` once its claim passes the staleness threshold, and the next`,
      `queue-runner starts it over from zero.`,
    ];
  }

  const markdown = [
    `### Worker run failed for \`${id}\``,
    "",
    ...body,
    "",
    `Either way the claim on \`${id}\` is **not released by this job**, and must not be:`,
    `releasing it from the failure path would race a worker that is still finishing.`,
    `**flow-recover** resolves it on the next sweep, on its own schedule, from the evidence on`,
    `the remote.`,
    "",
    `If this is the same task capping repeatedly, the cap is the symptom to look past, not the`,
    `thing to raise: the outcome above is what this run actually left behind, so compare it with`,
    `what the previous runs left — then consider splitting the task.`,
  ].join("\n");

  return { outcome, markdown };
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

// Flags -> renderClaimNotice inputs. The `--branch`/`--ahead` values come from the verify
// step's outputs, so the same flag names carry the same meaning in both modes.
export function explainArgsFromFlags(flags) {
  return {
    taskId: String(flags["task-id"] || ""),
    branch: String(flags.branch || ""),
    branchExists: Number(flags["branch-exists"] || 0) > 0,
    ahead: Number(flags.ahead || 0) || 0,
    hasOpenPr: Number(flags["has-open-pr"] || 0) > 0,
  };
}

// One CLI body, shared by this file's own entry point and canonical's adapter, so a mode added
// to one cannot be missing from the other. `--mode explain` renders the failure notice to
// stdout and exits 0 — it describes an outcome, it never judges one; the default mode returns
// the verdict and the exit code the queue-runner job reads.
export function runCli(argv, tasksDir, io = {}) {
  const flags = parseFlags(argv);
  if (flags.mode === "explain") {
    const { log = console.log, exit = process.exit } = io;
    log(renderClaimNotice(explainArgsFromFlags(flags)).markdown);
    exit(0);
    return;
  }
  reportAndExit(runVerify(verifyArgsFromFlags(flags, tasksDir)), io);
}

// ── CLI ── In an adopting repo this file is copied to `.flow/bin/`, so resolving the store
// relative to this file's own location lands on that repo's real `.flow/tasks/`. In canonical
// this default would land on the template's fixture store — which is why canonical runs its
// adapter, never this file directly.
if (__isMain) {
  const tasksDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "tasks");
  runCli(process.argv.slice(2), tasksDir);
}
