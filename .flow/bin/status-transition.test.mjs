// status-transition.test.mjs — the helper `_flow-status.yml` asks before it writes (flow-0169's
// blocked read, flow-0176's cancelled guard). The workflow-level proofs live in canonical's
// `.flow/bin/status-closed-cancelled.test.mjs`; these pin the helper's own contract.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { closedUnmerged, main, readStatus, readTask } from "./status-transition.mjs";

function store(tasks) {
  const dir = mkdtempSync(join(tmpdir(), "status-transition-"));
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir);
  for (const [name, src] of Object.entries(tasks)) writeFileSync(join(tasksDir, name), src);
  return { dir, tasksDir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const task = (id, status) => `---\nid: "${id}"\nstatus: "${status}"\n---\n\n---\nstatus: "prose"\n`;

test("readStatus reads frontmatter only, quoted or bare", () => {
  assert.equal(readStatus(task("x-1", "cancelled")), "cancelled");
  assert.equal(readStatus("---\nstatus: blocked\n---\n"), "blocked");
  assert.equal(readStatus("no frontmatter\nstatus: ready\n"), "");
  assert.equal(readStatus("---\nid: x\n---\nstatus: ready\n"), "", "a body `status:` is prose");
});

test("readTask finds by frontmatter id, and is empty for a missing task or store", () => {
  const s = store({ "a.md": task("x-1", "ready"), "b.md": task("x-10", "cancelled"), "n.txt": "id: x-1" });
  try {
    assert.equal(readStatus(readTask(s.tasksDir, "x-10")), "cancelled");
    assert.equal(readStatus(readTask(s.tasksDir, "x-1")), "ready", "x-1 must not match x-10");
    assert.equal(readTask(s.tasksDir, "x-2"), "");
    assert.equal(readTask(join(s.dir, "nope"), "x-1"), "");
  } finally { s.done(); }
});

test("closedUnmerged leaves only a cancelled task alone", () => {
  assert.equal(closedUnmerged({ id: "x-1", status: "cancelled" }).verdict, "leave");
  for (const status of ["in_progress", "in_review", "blocked", "ready", ""]) {
    assert.equal(closedUnmerged({ id: "x-1", status }).verdict, "ready", status || "(not found)");
  }
});

test("main: status prints, closed exits 3 for cancelled and writes the reset edit otherwise", () => {
  const s = store({ "a.md": task("x-1", "cancelled"), "b.md": task("x-2", "in_review") });
  const edits = join(s.dir, "edits.json");
  try {
    assert.deepEqual(main(["status", "--id", "x-1"], s), { code: 0, stdout: "cancelled\n" });

    const leave = main(["closed", "--id", "x-1", "--event-pr", "9", "--edits", edits], s);
    assert.equal(leave.code, 3);
    assert.match(leave.stdout, /PR #9 closed unmerged: x-1 is cancelled/);
    assert.throws(() => readFileSync(edits), "a cancelled task gets no edits file");

    const reset = main(["closed", "--id", "x-2", "--event-pr", "9", "--edits", edits], s);
    assert.equal(reset.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(edits, "utf8")),
      { updates: [{ id: "x-2", status: "ready", owner: "", branch: "", pr: "" }] });
    assert.equal(main(["closed", "--id", "x-2"], s).code, 0, "without --edits it only decides");
  } finally { s.done(); }
});

test("main: an unknown subcommand or a missing id is a usage error", () => {
  assert.equal(main(["frobnicate", "--id", "x-1"], { tasksDir: "/nonexistent" }).code, 2);
  assert.equal(main(["status"], { tasksDir: "/nonexistent" }).code, 2);
});
