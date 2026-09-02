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
