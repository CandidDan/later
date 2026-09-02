// Tests for apply-board-edits — the foundation's own Definition of Done applies to its
// tooling too. Zero-dep, uses the built-in node:test runner (Node >= 18):
//   node --test .flow/bin/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyEdits, STATUSES } from "./apply-board-edits.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "flow-tasks-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const task = (id, { status = "ready", priority = 3 } = {}) =>
  `---\nid: "${id}"\ntitle: "x"\nstatus: "${status}"\npriority: ${priority}\ntouches: ["src/**"]\nlabels: [a]\n---\n\n## Context\nbody\n`;

test("patches status and priority, nothing else", () => {
  const dir = fixture({ "0001-a.md": task("PROJ-0001") });
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0001", status: "in_progress", priority: 1 }] });
  assert.equal(applied, 1);
  assert.deepEqual(problems, []);
  const out = readFileSync(join(dir, "0001-a.md"), "utf8");
  assert.match(out, /^status: "in_progress"$/m);
  assert.match(out, /^priority: 1$/m);
  assert.match(out, /^touches: \["src\/\*\*"\]$/m);   // untouched
  assert.match(out, /## Context\nbody/);              // body untouched
  rmSync(dir, { recursive: true, force: true });
});

test("rejects an illegal status and writes nothing", () => {
  const dir = fixture({ "0001-a.md": task("PROJ-0001") });
  const before = readFileSync(join(dir, "0001-a.md"), "utf8");
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0001", status: "shipping" }] });
  assert.equal(applied, 0);
  assert.equal(problems.length, 1);
  assert.equal(readFileSync(join(dir, "0001-a.md"), "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects an out-of-range priority", () => {
  const dir = fixture({ "0001-a.md": task("PROJ-0001") });
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0001", priority: 9 }] });
  assert.equal(applied, 0);
  assert.equal(problems.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("missing task file is a WARNING (workflow no-op), not a problem", () => {
  // Live-validation finding: flow-status/flow-done fire on branches whose id has no task
  // file — that must exit green. Only malformed input should fail.
  const dir = fixture({ "0001-a.md": task("PROJ-0001") });
  const { applied, problems, warnings } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-9999", status: "done" }] });
  assert.equal(applied, 0);
  assert.deepEqual(problems, []);
  assert.match(warnings[0], /PROJ-9999: no task file/);
  rmSync(dir, { recursive: true, force: true });
});

test("never touches _TEMPLATE.md even if its id is referenced", () => {
  const dir = fixture({ "_TEMPLATE.md": task("PROJ-0000"), "0001-a.md": task("PROJ-0001") });
  const before = readFileSync(join(dir, "_TEMPLATE.md"), "utf8");
  const { applied } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0000", status: "done" }] });
  assert.equal(applied, 0);
  assert.equal(readFileSync(join(dir, "_TEMPLATE.md"), "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("done is a legal status (lifecycle end is reachable)", () => {
  assert.ok(STATUSES.has("done"));
  const dir = fixture({ "0001-a.md": task("PROJ-0001", { status: "in_review" }) });
  const { applied } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0001", status: "done" }] });
  assert.equal(applied, 1);
  assert.match(readFileSync(join(dir, "0001-a.md"), "utf8"), /^status: "done"$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("patches owner, branch and pr (the flow-status fields)", () => {
  const dir = fixture({ "0001-a.md": "---\nid: \"PROJ-0001\"\ntitle: \"x\"\nstatus: \"in_progress\"\npriority: 3\nowner: \"sess-1\"\nbranch: \"\"\npr: \"\"\n---\nbody\n" });
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [
    { id: "PROJ-0001", status: "in_review", branch: "flow/PROJ-0001-x", pr: "https://github.com/o/r/pull/7" },
  ]});
  assert.equal(applied, 1);
  assert.deepEqual(problems, []);
  const out = readFileSync(join(dir, "0001-a.md"), "utf8");
  assert.match(out, /^status: "in_review"$/m);
  assert.match(out, /^branch: "flow\/PROJ-0001-x"$/m);
  assert.match(out, /^pr: "https:\/\/github\.com\/o\/r\/pull\/7"$/m);
  assert.match(out, /^owner: "sess-1"$/m);   // untouched when not in the update
  rmSync(dir, { recursive: true, force: true });
});

test("clears owner/branch/pr with empty strings (close-unmerged reset)", () => {
  const dir = fixture({ "0001-a.md": "---\nid: \"PROJ-0001\"\ntitle: \"x\"\nstatus: \"in_review\"\npriority: 3\nowner: \"sess-1\"\nbranch: \"flow/PROJ-0001-x\"\npr: \"url\"\n---\nbody\n" });
  const { applied } = applyEdits({ tasksDir: dir, updates: [
    { id: "PROJ-0001", status: "ready", owner: "", branch: "", pr: "" },
  ]});
  assert.equal(applied, 1);
  const out = readFileSync(join(dir, "0001-a.md"), "utf8");
  assert.match(out, /^status: "ready"$/m);
  assert.match(out, /^owner: ""$/m);
  assert.match(out, /^branch: ""$/m);
  assert.match(out, /^pr: ""$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects string fields containing quotes or newlines", () => {
  const dir = fixture({ "0001-a.md": task("PROJ-0001") });
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [
    { id: "PROJ-0001", branch: 'evil" injected: true' },
  ]});
  assert.equal(applied, 0);
  assert.equal(problems.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("an unchanged update is a no-op (idempotent)", () => {
  const dir = fixture({ "0001-a.md": task("PROJ-0001", { status: "ready", priority: 3 }) });
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: [{ id: "PROJ-0001", status: "ready", priority: 3 }] });
  assert.equal(applied, 0);
  assert.deepEqual(problems, []);
  rmSync(dir, { recursive: true, force: true });
});
