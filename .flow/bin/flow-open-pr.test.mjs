// Tests for flow-open-pr — the auto-PR decision grades its own homework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideOpenPr, idFromBranch, readTaskTitle } from "./flow-open-pr.mjs";

// ── decideOpenPr: the happy path opens a PR with a correct [<id>] title ──

test("worker branch ahead of base with no open PR -> open-PR decision", () => {
  const d = decideOpenPr({
    branch: "flow/CAN-50-auto-open-pr",
    baseBranch: "main",
    hasOpenPr: false,
    aheadOfBase: true,
    taskTitle: "Auto-open the PR on worker branch push",
  });
  assert.deepEqual(d, {
    id: "CAN-50",
    title: "[CAN-50] Auto-open the PR on worker branch push",
    head: "flow/CAN-50-auto-open-pr",
    base: "main",
  });
});

// ── decideOpenPr: idempotency — never a second PR ──

test("branch that already has an open PR -> null (no duplicate)", () => {
  const d = decideOpenPr({
    branch: "flow/CAN-50-x",
    hasOpenPr: true,
    aheadOfBase: true,
    taskTitle: "t",
  });
  assert.equal(d, null);
});

// ── decideOpenPr: nothing to propose ──

test("branch with zero commits ahead of base -> null", () => {
  const d = decideOpenPr({ branch: "flow/CAN-50-x", hasOpenPr: false, aheadOfBase: false, taskTitle: "t" });
  assert.equal(d, null);
});

test("the base branch itself -> null (never PR main against main)", () => {
  const d = decideOpenPr({ branch: "main", baseBranch: "main", hasOpenPr: false, aheadOfBase: true });
  assert.equal(d, null);
});

// ── decideOpenPr: unparseable id ──

test("branch name with no parseable task id -> null (no malformed PR)", () => {
  const d = decideOpenPr({
    branch: "claude/blissful-edison-3srhxo",
    hasOpenPr: false,
    aheadOfBase: true,
    taskTitle: "whatever",
  });
  assert.equal(d, null);
});

// ── idFromBranch ──

test("idFromBranch parses flow/<id>-… and rejects everything else", () => {
  assert.equal(idFromBranch("flow/CAN-50-auto-open-pr"), "CAN-50");
  assert.equal(idFromBranch("flow/CAN-50"), "CAN-50");
  assert.equal(idFromBranch("claude/keen-maxwell-y272ah"), null);
  assert.equal(idFromBranch("main"), null);
});

// ── readTaskTitle: the thin file read used to build the title ──

test("readTaskTitle reads the title of the matching task file, else empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-open-pr-"));
  try {
    writeFileSync(
      join(dir, "0050-x.md"),
      '---\nid: "CAN-50"\ntitle: "Auto-open the PR on worker branch push"\nstatus: "ready"\n---\nbody\n',
    );
    writeFileSync(join(dir, "_TEMPLATE.md"), '---\nid: "TEMPLATE"\ntitle: "ignore me"\n---\n');
    assert.equal(readTaskTitle(dir, "CAN-50"), "Auto-open the PR on worker branch push");
    assert.equal(readTaskTitle(dir, "CAN-999"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideOpenPr title falls back to bare [<id>] when no task title is known", () => {
  const d = decideOpenPr({ branch: "flow/CAN-50-x", hasOpenPr: false, aheadOfBase: true, taskTitle: "" });
  assert.equal(d.title, "[CAN-50]");
});

// ── the `id` override: what makes recovery able to open a PR at all ──
//
// decideOpenPr derived the id ONLY from a `flow/<id>-…` branch. Recovery starts from the task
// file, so it always knows the id — but on a platform-assigned `claude/…` branch idFromBranch
// returns null and this returned null with it, meaning the reopen-pr path found the stranded
// branch and then silently opened nothing. Fixing branch DISCOVERY alone would have dead-ended
// here, which is why these two changes ship together.

test("an explicit id lets a non-flow/ branch get a PR (the recovery path)", () => {
  const d = decideOpenPr({
    branch: "claude/ecstatic-goodall-120itl",
    baseBranch: "main",
    hasOpenPr: false,
    aheadOfBase: true,
    taskTitle: "Recover stranded tasks",
    id: "CAN-51",
  });
  assert.deepEqual(d, {
    id: "CAN-51",
    title: "[CAN-51] Recover stranded tasks",
    head: "claude/ecstatic-goodall-120itl",
    base: "main",
  });
});

test("WITHOUT an explicit id the same branch still opens nothing — push-time is unchanged", () => {
  // _flow-open-pr.yml fires on every branch push and passes no id. Widening the branch rule
  // there would open a PR for any branch pushed to the repo, so the override is opt-in only.
  const d = decideOpenPr({
    branch: "claude/ecstatic-goodall-120itl",
    baseBranch: "main",
    hasOpenPr: false,
    aheadOfBase: true,
    taskTitle: "Recover stranded tasks",
  });
  assert.equal(d, null);
});

test("an explicit id does not bypass the other guards", () => {
  const base = {
    branch: "claude/foo-x", baseBranch: "main", taskTitle: "T", id: "CAN-51",
  };
  assert.equal(decideOpenPr({ ...base, hasOpenPr: true, aheadOfBase: true }), null,
    "an existing open PR still wins — recovery must stay idempotent");
  assert.equal(decideOpenPr({ ...base, hasOpenPr: false, aheadOfBase: false }), null,
    "a branch with nothing ahead of base still has nothing to propose");
  assert.equal(decideOpenPr({ ...base, branch: "main", hasOpenPr: false, aheadOfBase: true }), null,
    "never a PR for the base branch, id or no id");
});

test("an explicit id overrides a DIFFERENT id parsed from the branch", () => {
  // The task file is authoritative: the sweep resolved this branch from that task's own record.
  const d = decideOpenPr({
    branch: "flow/CAN-99-stale-slug",
    baseBranch: "main",
    hasOpenPr: false,
    aheadOfBase: true,
    taskTitle: "T",
    id: "CAN-51",
  });
  assert.equal(d.id, "CAN-51");
  assert.equal(d.title, "[CAN-51] T");
});
