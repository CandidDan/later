// Tests for queue-runner-verify — the job's verdict stops taking the worker's word for it.
//
// Criteria proved here (flow-0025):
//   · nothing pushed / no PR / not blocked -> FAIL, message names the id and all three outcomes
//   · branch ahead of main, no PR -> OK
//   · open PR -> OK
//   · blocked with a non-empty blocked_reason -> OK
//   · a `notes` entry alone -> still FAIL (deliberate: a note is not an outcome)
//   · every {branch-exists, ahead>0, has-open-pr, blocked} combination returns the documented
//     verdict, including the "task file not found" edge
// Criteria proved here (flow-0049):
//   · the failure notice states the run's ACTUAL outcome — open PR named (and never "no PR was
//     opened"), branch + commit count named, or the reset to `ready` — over every combination,
//     including the contradictory {no branch, open PR}
//   · every outcome keeps the two statements that were always right: this job does not release
//     the claim, and flow-recover owns that decision
// The canonical adapter's store resolution is proved in `.flow/bin/queue-runner-verify.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  explainArgsFromFlags,
  parseFlags,
  readTaskState,
  renderClaimNotice,
  reportAndExit,
  runCli,
  runVerify,
  verifyArgsFromFlags,
  verifyOutcome,
} from "./queue-runner-verify.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));

// ── verifyOutcome: the three passing outcomes ──

test("branch on origin ahead of main, no PR -> OK (branch-pushed)", () => {
  const v = verifyOutcome({ taskId: "CAN-50", branchExists: true, aheadOfBase: true });
  assert.equal(v.ok, true);
  assert.equal(v.outcome, "branch-pushed");
});

test("open PR -> OK (pr-open), even with no branch fact observed", () => {
  const v = verifyOutcome({ taskId: "CAN-50", hasOpenPr: true });
  assert.equal(v.ok, true);
  assert.equal(v.outcome, "pr-open");
});

test("task blocked with a non-empty blocked_reason -> OK (blocked)", () => {
  const v = verifyOutcome({
    taskId: "CAN-50", taskFound: true, status: "blocked", blockedReason: "needs a human decision",
  });
  assert.equal(v.ok, true);
  assert.equal(v.outcome, "blocked");
});

// ── verifyOutcome: the failing run, and what its message must carry ──

test("no branch, no PR, not blocked -> FAIL naming the id and all three checked outcomes", () => {
  const v = verifyOutcome({ taskId: "write-0003", taskFound: true, status: "in_progress" });
  assert.equal(v.ok, false);
  assert.equal(v.outcome, "none");
  // The run summary is the only artefact a human sees — id plus each outcome, by name.
  assert.match(v.message, /write-0003/);
  assert.match(v.message, /flow\/write-0003-\* branch on origin ahead of main/);
  assert.match(v.message, /open PR/);
  assert.match(v.message, /blocked_reason/);
  assert.match(v.message, /status "in_progress"/);
});

test("blocked with an EMPTY blocked_reason -> FAIL (a block with no reason is not a decision)", () => {
  for (const blockedReason of ["", "   "]) {
    const v = verifyOutcome({ taskId: "CAN-50", taskFound: true, status: "blocked", blockedReason });
    assert.equal(v.ok, false);
    assert.match(v.message, /blocked_reason is empty/);
  }
});

test("branch exists but NOT ahead of main -> FAIL, and the message says which half failed", () => {
  const v = verifyOutcome({ taskId: "CAN-50", branchExists: true, aheadOfBase: false, taskFound: true, status: "in_progress" });
  assert.equal(v.ok, false);
  assert.match(v.message, /found on origin but NOT ahead of main/);
});

test("task file not found -> FAIL with that edge named, unless a branch or PR saves the run", () => {
  const missing = verifyOutcome({ taskId: "CAN-99", taskFound: false });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /task file not found on main/);
  // A pushed branch or an open PR is still a verifiable outcome even if the store read failed.
  assert.equal(verifyOutcome({ taskId: "CAN-99", taskFound: false, branchExists: true, aheadOfBase: true }).ok, true);
  assert.equal(verifyOutcome({ taskId: "CAN-99", taskFound: false, hasOpenPr: true }).ok, true);
});

// ── verifyOutcome: exhaustive — every combination returns the documented verdict ──

test("all {branchExists, ahead, hasOpenPr, blocked} x {taskFound} combinations", () => {
  for (const branchExists of [false, true])
    for (const aheadOfBase of [false, true])
      for (const hasOpenPr of [false, true])
        for (const blocked of [false, true])
          for (const taskFound of [false, true]) {
            const v = verifyOutcome({
              taskId: "CAN-1", branchExists, aheadOfBase, hasOpenPr, taskFound,
              status: blocked ? "blocked" : "in_progress",
              blockedReason: blocked ? "why" : "",
            });
            // Documented verdict: pushed work, an open PR, or a reasoned block — on main,
            // which requires the task file to actually be there. Nothing else passes.
            const expected = (branchExists && aheadOfBase) || hasOpenPr || (blocked && taskFound);
            const label = JSON.stringify({ branchExists, aheadOfBase, hasOpenPr, blocked, taskFound });
            assert.equal(v.ok, expected, `verdict for ${label}`);
            assert.equal(typeof v.message, "string");
            assert.ok(v.message.includes("CAN-1"), `message names the id for ${label}`);
          }
});

// ── the deliberate decision: a notes entry alone is NOT an outcome ──

test("a task with a fresh notes entry but no branch/PR/block -> still FAIL", () => {
  const dir = mkdtempSync(join(tmpdir(), "qrv-notes-"));
  try {
    writeFileSync(join(dir, "0003-x.md"), [
      "---",
      'id: "write-0003"',
      'title: "Some task"',
      'status: "in_progress"',
      'owner: "session-abc"',
      'blocked_reason: ""',
      "notes:",
      '  - "2026-08-25: ran out of turns mid-build; nothing pushed; next action: restart the build"',
      "---",
      "body",
    ].join("\n"));
    const v = runVerify({ tasksDir: dir, taskId: "write-0003", branchExists: false, aheadOfBase: false, hasOpenPr: false });
    assert.equal(v.ok, false, "a note is a warm start for the next worker, not a finished outcome");
    assert.match(v.message, /notes.*entry alone is deliberately not a passing outcome/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readTaskState: the thin store read ──

test("readTaskState finds the matching task and extracts status + blocked_reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "qrv-state-"));
  try {
    writeFileSync(join(dir, "_TEMPLATE.md"), '---\nid: "XX-0"\nstatus: "ready"\n---\n');
    writeFileSync(join(dir, "0007-y.md"),
      '---\nid: "CAN-7"\ntitle: "t"\nstatus: "blocked"\nblocked_reason: "waiting on schema call"\n---\nbody\n');
    assert.deepEqual(readTaskState(dir, "CAN-7"),
      { found: true, status: "blocked", blockedReason: "waiting on schema call" });
    assert.deepEqual(readTaskState(dir, "CAN-8"), { found: false, status: "", blockedReason: "" },
      "no matching id -> not found, never a crash");
    assert.equal(readTaskState(dir, "XX-0").found, false, "_TEMPLATE.md is never a task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTaskState on a missing directory -> not found, never a throw", () => {
  assert.deepEqual(readTaskState("/nonexistent/tasks-dir", "CAN-1"),
    { found: false, status: "", blockedReason: "" });
});

// ── runVerify: store read folded into the verdict ──

test("runVerify reads the block from the store and passes on it", () => {
  const dir = mkdtempSync(join(tmpdir(), "qrv-run-"));
  try {
    writeFileSync(join(dir, "0009-z.md"),
      '---\nid: "CAN-9"\nstatus: "blocked"\nblocked_reason: "undecidable without the human"\n---\n');
    const v = runVerify({ tasksDir: dir, taskId: "CAN-9", branchExists: false, aheadOfBase: false, hasOpenPr: false });
    assert.equal(v.ok, true);
    assert.equal(v.outcome, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLI plumbing ──

test("parseFlags + verifyArgsFromFlags map the workflow's flags onto runVerify's inputs", () => {
  const flags = parseFlags(["--task-id", "CAN-50", "--branch-exists", "1", "--ahead", "3", "--has-open-pr", "0"]);
  assert.deepEqual(verifyArgsFromFlags(flags, "/some/tasks"), {
    tasksDir: "/some/tasks",
    taskId: "CAN-50",
    branchExists: true,
    aheadOfBase: true,
    hasOpenPr: false,
  });
  // Absent flags default to the failing side — the verifier must never pass on missing facts.
  assert.deepEqual(verifyArgsFromFlags(parseFlags([]), "/t"),
    { tasksDir: "/t", taskId: "", branchExists: false, aheadOfBase: false, hasOpenPr: false });
});

test("reportAndExit: pass -> stdout + exit 0; fail -> stderr + exit 1", () => {
  const calls = { log: [], error: [], exit: [] };
  const io = {
    log: (m) => calls.log.push(m),
    error: (m) => calls.error.push(m),
    exit: (c) => calls.exit.push(c),
  };
  reportAndExit({ ok: true, message: "fine" }, io);
  reportAndExit({ ok: false, message: "bad" }, io);
  assert.deepEqual(calls.log, ["fine"]);
  assert.deepEqual(calls.error, ["bad"]);
  assert.deepEqual(calls.exit, [0, 1]);
});

// ── the CLI itself: exit codes are the contract the workflow step relies on ──

const cli = (args) =>
  spawnSync(process.execPath, [join(BIN, "queue-runner-verify.mjs"), ...args], { encoding: "utf8" });

test("CLI exits 0 for a pushed branch and 1 for a run with nothing to show", () => {
  const pass = cli(["--task-id", "CAN-50", "--branch-exists", "1", "--ahead", "2", "--has-open-pr", "0"]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /OK/, "the CLI block must actually run — silence is the symlink failure mode");

  const fail = cli(["--task-id", "CAN-50", "--branch-exists", "0", "--ahead", "0", "--has-open-pr", "0"]);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /CAN-50/);
  assert.match(fail.stderr, /1\./, "the failure lists the outcomes it checked");
});

// ── renderClaimNotice: the failure notice states the run's actual outcome (flow-0049) ──
//
// The defect these close: the notice opened with the flat claim "No PR was opened" on a step
// gated `if: failure()` — any step failing — and then printed a two-branch hypothetical the
// verify step immediately before it already had the answer to.

const notice = (facts) => renderClaimNotice({ taskId: "CAN-50", ...facts });

// The one sentence every outcome shares, and the reason the whole step exists.
const assertClaimNotReleased = (md, label) => {
  assert.match(md, /not released by this job/, `claim disposition missing for ${label}`);
  assert.match(md, /flow-recover/, `flow-recover's ownership missing for ${label}`);
};

test("open PR -> names the PR and never claims that no PR was opened", () => {
  const v = notice({ branch: "flow/CAN-50-thing", branchExists: true, ahead: 2, hasOpenPr: true });
  assert.equal(v.outcome, "pr-open");
  assert.doesNotMatch(v.markdown, /No PR (was|is) open/i,
    "the old text asserted an absence `failure()` never established — a worker that opens its " +
    "PR and then exits non-zero fires this step too");
  assert.match(v.markdown, /pull request is open/);
  assert.match(v.markdown, /`flow\/CAN-50-thing`/, "the PR must be named, not merely implied");
  assertClaimNotReleased(v.markdown, "pr-open");
});

test("branch ahead of main, no PR -> names the branch, the count, and flow-recover reopening it", () => {
  const v = notice({ branch: "flow/CAN-50-thing", branchExists: true, ahead: 3 });
  assert.equal(v.outcome, "branch-ahead");
  assert.match(v.markdown, /`flow\/CAN-50-thing`/);
  assert.match(v.markdown, /3 commits ahead of `main`/);
  assert.match(v.markdown, /reopens the\n?PR from that branch/,
    "the operator must be told the work survives, not asked to guess which way it went");
  assertClaimNotReleased(v.markdown, "branch-ahead");
  // Singular/plural is the kind of detail that makes generated prose read as unmaintained.
  assert.match(notice({ branch: "b", branchExists: true, ahead: 1 }).markdown, /1 commit ahead/);
});

test("no branch on origin -> states the reset to `ready` past the staleness threshold", () => {
  const v = notice({});
  assert.equal(v.outcome, "nothing");
  assert.match(v.markdown, /no branch reached `origin`/);
  assert.match(v.markdown, /resets to `ready`.*staleness threshold/s);
  assertClaimNotReleased(v.markdown, "nothing");
});

test("branch on origin but not ahead -> nothing to recover, and it says so rather than promising a PR", () => {
  const v = notice({ branch: "flow/CAN-50-thing", branchExists: true, ahead: 0 });
  assert.equal(v.outcome, "branch-stale");
  assert.match(v.markdown, /not ahead of `main`/);
  assert.match(v.markdown, /resets to `ready`/);
  assert.doesNotMatch(v.markdown, /reopens the/,
    "there are no commits to reopen a PR from — promising one would be the same defect again");
  assertClaimNotReleased(v.markdown, "branch-stale");
});

test("every {branchExists, ahead>0, hasOpenPr} combination renders its documented outcome", () => {
  for (const branchExists of [false, true])
    for (const ahead of [0, 4])
      for (const hasOpenPr of [false, true]) {
        const label = JSON.stringify({ branchExists, ahead, hasOpenPr });
        const v = notice({ branch: branchExists ? "flow/CAN-50-thing" : "", branchExists, ahead, hasOpenPr });
        const expected = hasOpenPr
          ? "pr-open"
          : branchExists && ahead > 0 ? "branch-ahead"
          : branchExists ? "branch-stale" : "nothing";
        assert.equal(v.outcome, expected, `outcome for ${label}`);
        assert.match(v.markdown, /^### Worker run failed for `CAN-50`$/m, `header for ${label}`);
        assertClaimNotReleased(v.markdown, label);
      }
});

test("the contradictory {no branch, open PR} describes the PR, not the reset, and does not crash", () => {
  // Not hypothetical: the verify step falls back to matching a `[<id>]` PR title precisely
  // because a cloud worker can be forced onto a non-`flow/` branch.
  const v = notice({ branch: "", branchExists: false, ahead: 0, hasOpenPr: true });
  assert.equal(v.outcome, "pr-open");
  assert.match(v.markdown, /\[CAN-50\]/, "with no branch to name, the `[<id>]` title prefix is the PR's name");
  assert.doesNotMatch(v.markdown, /resets to `ready`/,
    "an open PR means the work is not being thrown away — describing a reset would be false");
  assertClaimNotReleased(v.markdown, "no-branch-open-pr");
});

test("renderClaimNotice is total: no arguments, junk counts and a missing id still render", () => {
  for (const facts of [undefined, {}, { ahead: "not-a-number" }, { ahead: -5, branchExists: true },
                       { taskId: "", branchExists: true, branch: "" }]) {
    const v = renderClaimNotice(facts);
    assert.equal(typeof v.markdown, "string");
    assert.ok(v.markdown.length > 0);
    assert.doesNotMatch(v.markdown, /undefined|NaN/, `junk leaked into the summary for ${JSON.stringify(facts)}`);
    assertClaimNotReleased(v.markdown, JSON.stringify(facts));
  }
});

// ── the explain mode's flag mapping and CLI ──

test("explainArgsFromFlags maps the verify step's outputs onto the renderer's inputs", () => {
  const flags = parseFlags(["--mode", "explain", "--task-id", "CAN-50", "--branch", "flow/CAN-50-x",
                            "--branch-exists", "1", "--ahead", "3", "--has-open-pr", "0"]);
  assert.deepEqual(explainArgsFromFlags(flags), {
    taskId: "CAN-50", branch: "flow/CAN-50-x", branchExists: true, ahead: 3, hasOpenPr: false,
  });
  // Absent flags: an empty notice is still renderable, and claims nothing it has not been told.
  assert.deepEqual(explainArgsFromFlags(parseFlags([])),
    { taskId: "", branch: "", branchExists: false, ahead: 0, hasOpenPr: false });
});

test("runCli: --mode explain prints the notice and exits 0; the default mode still judges", () => {
  const calls = { log: [], error: [], exit: [] };
  const io = { log: (m) => calls.log.push(m), error: (m) => calls.error.push(m), exit: (c) => calls.exit.push(c) };
  runCli(["--mode", "explain", "--task-id", "CAN-50", "--branch-exists", "0", "--ahead", "0", "--has-open-pr", "0"], "/t", io);
  assert.match(calls.log[0], /### Worker run failed for `CAN-50`/);
  assert.deepEqual(calls.exit, [0], "describing an outcome must never fail the job a second time");
  // Same argv shape without the mode flag is the verdict path — and that one does fail.
  runCli(["--task-id", "CAN-50", "--branch-exists", "0", "--ahead", "0", "--has-open-pr", "0"], "/t", io);
  assert.match(calls.error[0], /queue-runner-verify: FAIL/);
  assert.deepEqual(calls.exit, [0, 1]);
});

test("CLI --mode explain writes the notice to stdout and exits 0", () => {
  const r = cli(["--mode", "explain", "--task-id", "CAN-50", "--branch", "flow/CAN-50-x",
                 "--branch-exists", "1", "--ahead", "2", "--has-open-pr", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 commits ahead of `main`/,
    "silence here is the symlink failure mode — the step would append an empty summary");
});
