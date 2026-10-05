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

// ── flow-0111: block-form `touches` ──
// Every real task file writes `touches` as a YAML block sequence. pick-task used to read only
// the inline array, so the overlap filter saw [] everywhere and never skipped anything.

const taskText = (id, status, touchesYaml) =>
  `---\nid: "${id}"\nstatus: "${status}"\npriority: 2\ntouches:${touchesYaml}\nlabels: [x]\n---\n\n## Context\n`;

test("flow-0111: parseTask reads block-form touches, quotes stripped, comments ignored", () => {
  const t = parseTask(taskText("CAN-1", "ready", '\n  - "src/a.mjs"   # the helper\n  - \'src/b/**\'\n'));
  assert.deepEqual(t.touches, ["src/a.mjs", "src/b/**"]);
});

test("flow-0111: parseTask still reads the inline-array form exactly as before", () => {
  const t = parseTask(taskText("CAN-2", "ready", ' ["src/a.mjs", "src/b/**"]  # inline'));
  assert.deepEqual(t.touches, ["src/a.mjs", "src/b/**"]);
});

test("flow-0111: a ready task sharing a path with an in_progress task is skipped, both in block form", () => {
  const running = parseTask(taskText("CAN-10", "in_progress", '\n  - "lib/globalSetup.ts"\n  - "lib/a.ts"\n'));
  const clash = parseTask(taskText("CAN-11", "ready", '\n  - "lib/globalSetup.ts"\n'));
  const clear = parseTask(taskText("CAN-12", "ready", '\n  - "docs/x.md"\n'));
  assert.equal(pickTask([running, clash]), null, "the overlapping task must not be dispatched");
  assert.equal(pickTask([running, clash, clear]), "CAN-12");
});

test("flow-0111: no task in a real store that declares touches parses to an empty list", async () => {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  // This repo's own store (an adopter's synced copy sits in .flow/bin, so ../tasks), and in
  // canonical, where this file lives under project-template/, the canonical store as well.
  const stores = [resolve(here, "..", "tasks"), resolve(here, "..", "..", "..", ".flow", "tasks")]
    .filter((d, i, all) => existsSync(d) && all.indexOf(d) === i);
  let checked = 0;
  for (const dir of stores) {
    const parsed = new Map(readTasks(dir).map((t) => [t.id, t]));
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "_TEMPLATE.md")) {
      const head = readFileSync(join(dir, name), "utf8").split("\n---")[0];
      const declares = /^touches:\s*(\[\s*["'][^\]]+\]|\n\s*-\s)/m.test(head);
      const id = (head.match(/^id:\s*"?([^"\n]+)"?/m) || [])[1];
      if (!declares || !id || !parsed.has(id)) continue;
      checked += 1;
      assert.ok(parsed.get(id).touches.length > 0, `${name}: touches declared but parsed as empty`);
    }
  }
  assert.ok(checked > 0, "found no task declaring touches — the guard proved nothing");
});

test("flow-0111: pick-task has one list parser, flow-doctor's, and no touches regex of its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./pick-task.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ parseListField \} from "\.\/flow-doctor\.mjs";/);
  assert.doesNotMatch(src, /\/\^touches:/, "a second touches regex is how this bug happened");
});

// The changelog fragment lives in canonical only (changes/ is not synced to adopters), so this
// proves it where it exists and skips visibly everywhere else.
{
  const { existsSync, readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const fragment = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "changes", "flow-0111.md");
  test("flow-0111 has a changelog fragment that says the caller does nothing",
    { skip: existsSync(fragment) ? false : "not canonical: changes/ is not synced to adopting repos" },
    () => {
      assert.match(readFileSync(fragment, "utf8"), /Caller action: none/);
    });
}

// ── flow-0118: `in_review` is still in flight ──────────────────────────────────────────
//
// Observed on 2026-10-01 in CandidDan/inflight: `inflight-0015` was `in_review` (PR #30 open,
// unmerged) and `inflight-0016` was `ready` with four overlapping paths. The queue runner
// dispatched 0016 anyway, because this selector only excluded overlap against `in_progress`.
// The worker noticed and blocked itself by hand; nothing in the code made it. A review-stage PR
// has a live branch about to rewrite `main` in exactly the files it declared, so for collision
// purposes it has not landed. `blocked` is the deliberate exception — no live branch, and
// `blocked_by` sequences it already.

test("flow-0118: skips a ready task whose touches overlap an in_review task", () => {
  const id = pickTask([
    T("CAN-15", { priority: 1, status: "in_review", touches: ["app/_components/needs-you.js", "bin/home-view.mjs"] }),
    T("CAN-16", { priority: 1, status: "ready", touches: ["bin/home-view.mjs"] }),
  ]);
  assert.equal(id, null, "an unmerged PR still holds its files — dispatching here is a merge conflict");
});

test("flow-0118: the same pair with the other task in_progress still blocks — old behaviour kept", () => {
  const id = pickTask([
    T("CAN-15", { priority: 1, status: "in_progress", touches: ["app/_components/needs-you.js", "bin/home-view.mjs"] }),
    T("CAN-16", { priority: 1, status: "ready", touches: ["bin/home-view.mjs"] }),
  ]);
  assert.equal(id, null);
});

test("flow-0118: overlap with only a blocked and a done task does NOT hold a ready task back", () => {
  const id = pickTask([
    T("CAN-1", { priority: 1, status: "blocked", touches: ["bin/home-view.mjs"] }),
    T("CAN-2", { priority: 1, status: "done", touches: ["bin/home-view.mjs"] }),
    T("CAN-3", { priority: 2, status: "ready", touches: ["bin/home-view.mjs"] }),
  ]);
  assert.equal(id, "CAN-3", "a blocked task has no live branch, and a done one has already landed");
});

test("flow-0118: an in_review overlap defers to the next eligible task, it does not stall the queue", () => {
  const id = pickTask([
    T("CAN-15", { priority: 1, status: "in_review", touches: ["app/dashboard/**"] }),
    T("CAN-16", { priority: 1, status: "ready", touches: ["app/dashboard/Hero.tsx"] }), // overlaps -> skip
    T("CAN-17", { priority: 3, status: "ready", touches: ["docs/x.md"] }),              // clear, lower priority
  ]);
  assert.equal(id, "CAN-17", "sort order is unchanged; the P1 is skipped on overlap, not de-prioritised");
});

test("flow-0118: the in_review guard holds on block-form touches read off disk by readTasks", () => {
  // Every real task file writes `touches` as a YAML block sequence. The guard must not fail open
  // on the parse — flow-0111 is exactly that bug, and a new filter is a new chance to reintroduce it.
  const dir = mkdtempSync(join(tmpdir(), "pick-0118-"));
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir);
  const file = (id, status, paths) =>
    `---\nid: "${id}"\nstatus: "${status}"\npriority: 2\ntouches:\n${paths.map((p) => `  - "${p}"\n`).join("")}---\n\n## Context\n`;
  writeFileSync(join(tasksDir, "0015-a.md"), file("CAN-15", "in_review", ["app/_components/needs-you.js", "bin/home-view.mjs"]));
  writeFileSync(join(tasksDir, "0016-b.md"), file("CAN-16", "ready", ["bin/home-view.mjs"]));
  writeFileSync(join(tasksDir, "0017-c.md"), file("CAN-17", "ready", ["docs/x.md"]));
  const tasks = readTasks(tasksDir);
  assert.deepEqual(tasks.find((t) => t.id === "CAN-15").touches,
    ["app/_components/needs-you.js", "bin/home-view.mjs"], "fixture must parse, or the assertion below is vacuous");
  assert.equal(pickTask(tasks), "CAN-17");
  assert.equal(pickTask(tasks.filter((t) => t.id !== "CAN-17")), null);
  rmSync(dir, { recursive: true, force: true });
});

test("flow-0118: both statements of the claim rule in PROTOCOL.md name in_review", async () => {
  // The rule lives in two places: the *Concurrency* paragraph on `touches`, and step 1 of *The
  // loop you run*. A human worker follows the prose, not this file, so prose that still says only
  // `in_progress` is the same bug wearing a different hat. Asserted here so they cannot drift.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");

  const blastRadius = src.match(/\*\*`touches` declares the blast radius\.\*\*[\s\S]*?\n\n/);
  assert.ok(blastRadius, "could not find the Concurrency paragraph on `touches`");
  assert.match(blastRadius[0], /`in_progress`[\s\S]{0,40}`in_review`/,
    "the `touches` paragraph must name `in_review` alongside `in_progress`");

  const step1 = src.match(/\n1\. \*\*Pick\.\*\*[\s\S]*?\n2\. /);
  assert.ok(step1, "could not find step 1 of The loop you run");
  assert.match(step1[0], /`in_progress`[\s\S]{0,40}`in_review`/,
    "step 1 must name `in_review` alongside `in_progress`");
});

// The changelog entry lives in canonical only (`changes/` is not synced to adopters), so this
// skips visibly everywhere else. Read through `changelog-entry.mjs`, never `changes/<id>.md`
// directly: a release folds the fragment into CHANGELOG.md and deletes it, so a direct read is
// green until the release PR and red on it. Imported dynamically, because this file ships to
// adopting repos, which have no such helper.
{
  const { existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const CANON = existsSync(join(root, ".flow", "bin", "changelog-entry.mjs")) ? root : null;

  test("flow-0118 has a changelog entry naming the queue runner's new skip",
    { skip: CANON ? false : "canonical-only: `changes/` and CHANGELOG.md are not synced to adopting repos" },
    async () => {
      const { changelogEntry } = await import(pathToFileURL(join(CANON, ".flow", "bin", "changelog-entry.mjs")).href);
      const text = changelogEntry(CANON, "flow-0118");
      assert.ok(text, "flow-0118's changelog entry must exist, as a fragment or in CHANGELOG.md");
      assert.match(text, /in_review/, "the entry must name the status that now holds a ready task back");
      assert.match(text, /caller action/i, "the entry must state whether a caller has to act");
    });
}
