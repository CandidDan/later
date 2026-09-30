// Tests for pick-task — the queue-runner's selector grades its own homework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTask, staticPrefix, globsOverlap, touchesOverlap, pickTask, readTasks,
} from "./pick-task.mjs";

const T = (id, f = {}) => ({
  id, status: f.status ?? "ready", priority: f.priority ?? 3, touches: f.touches ?? ["src/**"],
});

// ── pickTask: priority + tie-break ──

test("picks the lowest priority NUMBER among ready tasks (P1 most urgent)", () => {
  const id = pickTask([T("CAN-1", { priority: 3 }), T("CAN-2", { priority: 1 }), T("CAN-3", { priority: 4 })]);
  assert.equal(id, "CAN-2");
});

test("ties on priority break by numeric id suffix ascending", () => {
  const id = pickTask([T("CAN-43", { priority: 1 }), T("CAN-42", { priority: 1 })]);
  assert.equal(id, "CAN-42");
});

test("only `ready` tasks are eligible — others are skipped", () => {
  // distinct touches so the in_progress task can't mask CAN-5 via overlap — this isolates
  // the status filter from the overlap filter (which has its own tests below).
  const id = pickTask([
    T("CAN-1", { priority: 1, status: "in_progress", touches: ["a/**"] }),
    T("CAN-2", { priority: 1, status: "blocked", touches: ["b/**"] }),
    T("CAN-3", { priority: 1, status: "in_review", touches: ["c/**"] }),
    T("CAN-4", { priority: 1, status: "done", touches: ["d/**"] }),
    T("CAN-5", { priority: 2, status: "ready", touches: ["e/**"] }),
  ]);
  assert.equal(id, "CAN-5");
});

test("returns null when there are no ready tasks", () => {
  assert.equal(pickTask([T("CAN-1", { status: "done" }), T("CAN-2", { status: "blocked" })]), null);
  assert.equal(pickTask([]), null);
});

// ── pickTask: touches overlap against in_progress ──

test("skips a ready task whose touches overlap an in_progress task", () => {
  const id = pickTask([
    T("CAN-1", { priority: 1, status: "in_progress", touches: ["app/dashboard/**"] }),
    T("CAN-2", { priority: 1, status: "ready", touches: ["app/dashboard/Hero.tsx"] }), // overlaps -> skip
    T("CAN-3", { priority: 2, status: "ready", touches: ["app/api/**"] }),             // clear
  ]);
  assert.equal(id, "CAN-3");
});

test("a ready task whose touches don't overlap any in_progress task is eligible", () => {
  const id = pickTask([
    T("CAN-1", { priority: 5, status: "in_progress", touches: [".flow/bin/pick-task.mjs"] }),
    T("CAN-2", { priority: 1, status: "ready", touches: ["app/components/**"] }),
  ]);
  assert.equal(id, "CAN-2");
});

// ── glob overlap primitives ──

test("staticPrefix strips at the first wildcard", () => {
  assert.equal(staticPrefix("src/components/signup/**"), "src/components/signup/");
  assert.equal(staticPrefix("app/vercel.json"), "app/vercel.json");
  assert.equal(staticPrefix("**"), "");
});

test("globsOverlap: identical paths, enclosing dir, and ** all overlap", () => {
  assert.ok(globsOverlap("app/vercel.json", "app/vercel.json"));
  assert.ok(globsOverlap("src/**", "src/lib/x.ts"));
  assert.ok(globsOverlap("**", "anything/at/all.ts"));
});

test("globsOverlap: sibling files and disjoint trees do not overlap", () => {
  assert.equal(globsOverlap(".flow/bin/pick-task.mjs", ".flow/bin/pick-task.test.mjs"), false);
  assert.equal(globsOverlap("src/a/**", "src/b/**"), false);
  assert.equal(globsOverlap("app/api/**", ".flow/board.html"), false);
});

test("touchesOverlap: true iff any glob pair across the lists overlaps", () => {
  assert.ok(touchesOverlap(["app/api/**", "src/x.ts"], ["src/**"]));
  assert.equal(touchesOverlap(["app/api/**"], [".flow/board.html", "docs/x.md"]), false);
});

// ── parseTask + readTasks (file IO) ──

const taskFile = (id, f = {}) => `---
id: "${id}"
title: "${f.title ?? "x"}"
status: "${f.status ?? "ready"}"
priority: ${f.priority ?? 3}
touches: ${f.touches ?? '[".flow/bin/x.mjs"]'}
---
body
`;

test("parseTask reads id/status/priority/touches and ignores non-frontmatter", () => {
  const t = parseTask(taskFile("CAN-99", { status: "ready", priority: 2, touches: '["a/**", "b.ts"]' }));
  assert.deepEqual(t, { id: "CAN-99", status: "ready", priority: 2, touches: ["a/**", "b.ts"] });
  assert.equal(parseTask("no frontmatter here"), null);
});

test("readTasks parses a dir, skips _TEMPLATE.md, and pickTask selects across them", () => {
  const dir = mkdtempSync(join(tmpdir(), "pick-"));
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir);
  writeFileSync(join(tasksDir, "0001-a.md"), taskFile("CAN-1", { priority: 4, touches: '["x/**"]' }));
  writeFileSync(join(tasksDir, "0002-b.md"), taskFile("CAN-2", { priority: 1, touches: '["y/**"]' }));
  writeFileSync(join(tasksDir, "_TEMPLATE.md"), taskFile("TEMPLATE", { priority: 1 }));
  const tasks = readTasks(tasksDir);
  assert.equal(tasks.length, 2);                 // template excluded
  assert.equal(pickTask(tasks), "CAN-2");        // P1 wins
  rmSync(dir, { recursive: true, force: true });
});

// ── flow-0069: the changelog was the queue's bottleneck ────────────────────────────────
//
// `touches` overlap is a CLAIM guard, not documentation — and `CHANGELOG.md` is append-only, so
// every task that changed anything declared it. A path in every task's `touches` makes almost
// every task ineligible the moment any one is claimed: measured on canonical on 2026-09-23, 12 of
// 23 open tasks listed it, 9 of them among the 13 `ready` ones. Nothing was ever in real conflict.
//
// The two cases below are the before and the after, on the same pair of tasks, differing only in
// how each declares its changelog entry. They are the proving test for the convention that the
// rest of flow-0069 builds on — the assembler exists to make this shape livable, not the reverse.

test("two tasks declaring per-task changelog fragments do NOT block each other", () => {
  const id = pickTask([
    T("flow-0101", { priority: 1, status: "in_progress", touches: [".flow/bin/a.mjs", "changes/flow-0101.md"] }),
    T("flow-0102", { priority: 1, status: "ready", touches: [".flow/bin/b.mjs", "changes/flow-0102.md"] }),
  ]);
  assert.equal(id, "flow-0102",
    "fragments are distinct files; the ready task must stay claimable while the other runs");
});

test("the same two tasks sharing CHANGELOG.md block each other — the jam this convention removes", () => {
  const id = pickTask([
    T("flow-0101", { priority: 1, status: "in_progress", touches: [".flow/bin/a.mjs", "CHANGELOG.md"] }),
    T("flow-0102", { priority: 1, status: "ready", touches: [".flow/bin/b.mjs", "CHANGELOG.md"] }),
  ]);
  assert.equal(id, null,
    "one shared append-only file is enough to make the whole queue ineligible — that is the bug");
});

test("a fragment path does not collide with a neighbouring fragment by prefix", () => {
  // The overlap test is a path-PREFIX test at a segment boundary. `changes/flow-1.md` must not be
  // read as a prefix of `changes/flow-10.md`, or ids would start blocking each other by accident.
  assert.equal(globsOverlap("changes/flow-1.md", "changes/flow-10.md"), false);
  assert.equal(globsOverlap("changes/flow-0101.md", "changes/flow-0102.md"), false);
  assert.ok(globsOverlap("changes/flow-0101.md", "changes/flow-0101.md"));
  assert.ok(touchesOverlap(["CHANGELOG.md"], ["CHANGELOG.md"]));
});
