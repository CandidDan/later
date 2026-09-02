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
