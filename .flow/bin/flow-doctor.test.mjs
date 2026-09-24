// Tests for flow-doctor — the store validator validates itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runDoctor, compareVersions, findUncommittedTasks, parseVisionGoals, readinessFindings, blockedByFindings, isBlockedByEntry } from "./flow-doctor.mjs";

// The vision every fixture gets unless it asks for none: two live goals, one non-goal, one
// retired goal. Written in the shape flow-doctor's line regex reads, deliberately mixing the
// em dash and the hyphen — humans type both, and the checker has to survive that.
const VISION = `# Vision — the fixture repo

## Goals

### G1 — Ship the thing
Because the thing is the point.

### G2 - Ship the other thing

## Non-goals

### NG1 — Become a project-management product

## Retired

### G9 — The thing we stopped doing
Retired 2026-08-18: superseded by G1.
`;

// A body that meets the readiness bar: the three required sections and one real criterion.
const READY_BODY = `
## Context

Why this task exists, in enough detail that a fresh session doesn't have to ask.

## Scope

What it changes, and what it deliberately leaves alone.

## Acceptance criteria

- [ ] Given a drifted store, when flow-doctor runs, then it names the task and the drift.

## Notes / open questions

None.
`;

// A repo-shaped fixture — <repo>/.flow/tasks/… — so every check that keys off the repo root
// (VISION.md, the new-subsystem tell, source_roots) sees only what the test created, and not
// whatever happens to sit in the system temp dir.
//   dirs    top-level dirs to materialise. Defaults to the root the default `touches` points
//           at, so the new-subsystem warning fires only where a test deliberately omits one.
//   vision  VISION.md content, or null for a repo that has no vision at all.
function fixture(files, { dirs = ["src"], vision = VISION } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "flow-doc-"));
  mkdirSync(join(repo, ".flow", "tasks"), { recursive: true });
  for (const d of dirs) mkdirSync(join(repo, d), { recursive: true });
  if (vision !== null) writeFileSync(join(repo, "VISION.md"), vision);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, ".flow", "tasks", name), body);
  return join(repo, ".flow");
}
// Removes the whole fixture repo, not just the `.flow` inside it.
const cleanup = (flowDir) => rmSync(dirname(flowDir), { recursive: true, force: true });

const task = (id, f = {}) => `---
id: "${id}"
title: "${f.title ?? "x"}"
status: "${f.status ?? "ready"}"
priority: ${f.priority ?? 3}
owner: "${f.owner ?? ""}"
started: "${f.started ?? ""}"
branch: "${f.branch ?? ""}"
pr: "${f.pr ?? ""}"
blocked_reason: "${f.blocked_reason ?? ""}"
${f.blocked_by === undefined ? "" : `blocked_by: ${f.blocked_by}\n`}serves: ${f.serves ?? '["G1"]'}
touches: ${f.touches ?? '["src/**"]'}
---
${f.body ?? READY_BODY}`;

test("healthy store: no problems, no warnings", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.count, 1);
  cleanup(d);
});

test("duplicate ids and illegal status are problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001"),
    "0002-b.md": task("P-0001"),
    "0003-c.md": task("P-0003", { status: "shipping" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("duplicate id")));
  assert.ok(r.problems.some((p) => p.includes('illegal status "shipping"')));
  cleanup(d);
});

test("in_review without pr, blocked without reason, incomplete claim — all problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_review", branch: "flow/P-0001-x" }),       // no pr
    "0002-b.md": task("P-0002", { status: "blocked" }),                                   // no reason
    "0003-c.md": task("P-0003", { status: "in_progress", owner: "sess" }),                // no started
  });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.problems.length, 3);
  cleanup(d);
});

test("ready with stale owner or empty touches — warnings, not problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { owner: "sess-old" }),
    "0002-b.md": task("P-0002", { touches: "[]" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 2);
  cleanup(d);
});

test("board snapshot drift is a warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-06-05" }) });
  writeFileSync(join(d, "board.html"),
    `<script>\nconst TASKS = [\n  {id:"P-0001", title:"x", status:"ready", priority:3},\n  {id:"P-9999", title:"ghost", status:"done", priority:3},\n];\n</script>`);
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001=ready, files say in_progress")));
  assert.ok(r.warnings.some((w) => w.includes("P-9999 but no task file")));
  cleanup(d);
});

test("malformed frontmatter and missing fields are problems", () => {
  const d = fixture({
    "0001-a.md": "no frontmatter at all\n",
    "0002-b.md": `---\nid: "P-0002"\nstatus: "ready"\npriority: 3\n---\nbody\n`,   // no title
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("malformed frontmatter")));
  assert.ok(r.problems.some((p) => p.includes("missing required field(s): title")));
  cleanup(d);
});

// ── touches overlap (false "parallel-safe" detection) ──

test("overlapping touches on two ready tasks → warning naming both, not a problem", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '["app/x/**", "app/shared/page.ts"]' }),
    "0002-b.md": task("P-0002", { touches: '["app/y/**", "app/shared/page.ts"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("P-0002") && w.includes("overlapping touches")));
  cleanup(d);
});

test("overlapping touches on two in_progress tasks → problem (atomic-claim bypassed)", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s1", started: "2026-06-05", touches: '["app/shared/**"]' }),
    "0002-b.md": task("P-0002", { status: "in_progress", owner: "s2", started: "2026-06-05", touches: '["app/shared/util.ts"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("P-0002") && p.includes("in_progress")));
  cleanup(d);
});

test("disjoint touches → no overlap warning (different trees are genuinely parallel-safe)", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '["app/whisper/**"]' }),
    "0002-b.md": task("P-0002", { touches: '["app/meetings/**"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("overlapping touches")));
  cleanup(d);
});

test("multi-line touches form parses (not misread as empty) AND feeds overlap — the CAN-42/43 case", () => {
  const ml = (id, p) => `---
id: "${id}"
title: "x"
status: "ready"
priority: 3
owner: ""
started: ""
branch: ""
pr: ""
blocked_reason: ""
serves: ["G1"]
touches:
  - "${p}"
labels: [x]
---
${READY_BODY}`;
  const d = fixture({ "0001-a.md": ml("P-0001", "app/focus/page.tsx"), "0002-b.md": ml("P-0002", "app/focus/page.tsx") });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("empty touches")), "multi-line touches must not read as empty");
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("P-0002") && w.includes("overlapping")), "shared file must be flagged");
  cleanup(d);
});

// ── gate-coverage floor (source_roots) ──
// Repo-shaped fixture: a clean root holding .flow/ + arbitrary source trees, so the scan
// (which keys off dirname(flowDir)) sees only what we create.
function repoFixture({ config, trees = {} }) {
  const repo = mkdtempSync(join(tmpdir(), "flow-repo-"));
  mkdirSync(join(repo, ".flow", "tasks"), { recursive: true });
  writeFileSync(join(repo, ".flow", "tasks", "0001-a.md"), task("P-0001"));
  if (config !== undefined) writeFileSync(join(repo, ".flow", "config.yml"), config);
  for (const [path, file] of Object.entries(trees)) {
    mkdirSync(join(repo, path), { recursive: true });
    writeFileSync(join(repo, path, file), "export const x = 1;\n");
  }
  return { repo, flowDir: join(repo, ".flow") };
}
const cfg = (roots) =>
  "source_roots:\n" + roots.map((r) => `  - path: "${r.path}"\n    check: "${r.check ?? ""}"`).join("\n") + "\n";

test("source_roots: every tree declared + covered → clean", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }, { path: "supabase/functions/", check: "deno check supabase/functions/**/*.ts" }]),
    trees: { "app/src": "index.ts", "supabase/functions/process-inbound": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: an UNDECLARED top-level source tree FAILS (the BOOT_ERROR class)", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }]),               // declares app only
    trees: { "app/src": "index.ts", "supabase/functions/x": "index.ts" }, // supabase/ undeclared
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"supabase/"') && p.includes("not covered")));
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: declared root missing on disk, or with no check → problems", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "" }, { path: "ghost/", check: "x" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"app/" has no check')));
  assert.ok(r.problems.some((p) => p.includes('"ghost/" does not exist')));
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: config present but none declared → adoption warning, not failure", () => {
  const { repo, flowDir } = repoFixture({ config: "project:\n  name: x\n", trees: { "app/src": "index.ts" } });
  const r = runDoctor({ flowDir });
  assert.ok(r.warnings.some((w) => w.includes("no source_roots declared")));
  assert.ok(!r.problems.some((p) => p.includes("source")));
  rmSync(repo, { recursive: true, force: true });
});

// ── uncalibrated vs stale (flow-0017) ──
// A source_root still holding the shipped REPLACE-ME sentinel is "not yet calibrated", not
// "drifted" — it must warn, never fail, and must not let the gate-coverage floor pass silently.

test("source_roots: the shipped REPLACE-ME/REPLACE-ME entry alone → clean exit, one warning naming it", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "REPLACE-ME/", check: "REPLACE-ME" }]),
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes('"REPLACE-ME/"') && /uncalibrated/i.test(w)),
    "no warning names the uncalibrated source_root");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: a real, non-placeholder path missing on disk is still a stale-declaration PROBLEM", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "ghost/", check: "npm run lint" }]),
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"ghost/" does not exist') && /stale declaration/.test(p)));
  assert.ok(!r.warnings.some((w) => /uncalibrated/i.test(w)), "a real stale path must not read as uncalibrated");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: half-calibrated — one real root plus one REPLACE-ME entry — neither goes silent", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }, { path: "REPLACE-ME/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, [], "the real, calibrated root must not fail alongside the placeholder");
  assert.ok(r.warnings.some((w) => w.includes('"REPLACE-ME/"') && /uncalibrated/i.test(w)),
    "the placeholder entry produced no warning — it went silent");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: real, present path but placeholder check → uncalibrated warning, not a silent pass", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes('"app/"') && /uncalibrated/i.test(w)),
    "a REPLACE-ME check on a real path must still warn — the truthy-placeholder hole must stay closed");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: uncalibrated config + an undeclared top-level source tree — the backstop still fires", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "REPLACE-ME/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"app/"') && p.includes("not covered")),
    "the uncalibrated placeholder must not appear to cover a real, undeclared source tree");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: an entry with an empty path is the existing PROBLEM, not reclassified as uncalibrated", () => {
  const { repo, flowDir } = repoFixture({
    config: 'source_roots:\n  - path: ""\n    check: "npm run lint"\n',
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p === "source_root with no path in config.yml"));
  assert.ok(!r.warnings.some((w) => /uncalibrated/i.test(w)), "an empty path is malformed config, not a placeholder");
  rmSync(repo, { recursive: true, force: true });
});

// ── version drift (Flow infra is authored in canonical; repos adopt — the guard) ──

test("compareVersions: orders, tolerates v-prefix and short forms", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("v2", "v1.5"), 1);
});

test("version drift: no canonical version supplied → check is inert (no version warning)", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "0.1.0\n");
  const r = runDoctor({ flowDir: d });               // canonicalVersion undefined
  assert.deepEqual(r.problems, []);
  assert.ok(!r.warnings.some((w) => w.includes("behind canonical") || w.includes("VERSION stamp")));
  cleanup(d);
});

test("version drift: repo behind canonical → warning, not a problem", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "0.1.0\n");
  const r = runDoctor({ flowDir: d, canonicalVersion: "0.2.0" });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("behind canonical") && w.includes("0.1.0") && w.includes("0.2.0")));
  cleanup(d);
});

test("version drift: repo level with canonical → no warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "1.0.0\n");
  const r = runDoctor({ flowDir: d, canonicalVersion: "1.0.0" });
  assert.ok(!r.warnings.some((w) => w.includes("behind canonical")));
  cleanup(d);
});

test("version drift: canonical known but no .flow/VERSION stamp → adoption warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });   // no VERSION file written
  const r = runDoctor({ flowDir: d, canonicalVersion: "0.2.0" });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("no .flow/VERSION stamp")));
  cleanup(d);
});

// ── uncommitted-task guard (CAN-41) ──

test("findUncommittedTasks: untracked task file is offending", () => {
  const porcelain = "?? .flow/tasks/0099-x.md\n M src/app.ts\n";
  assert.deepEqual(findUncommittedTasks(porcelain), [".flow/tasks/0099-x.md"]);
});

test("findUncommittedTasks: staged-but-uncommitted change to a tracked task is offending", () => {
  assert.deepEqual(findUncommittedTasks("M  .flow/tasks/0030-slim.md\n"), [".flow/tasks/0030-slim.md"]);
});

test("findUncommittedTasks: unstaged worktree change to a tracked task is offending", () => {
  assert.deepEqual(findUncommittedTasks(" M .flow/tasks/0030-slim.md\n"), [".flow/tasks/0030-slim.md"]);
});

test("findUncommittedTasks: _TEMPLATE.md and non-task changes are ignored", () => {
  const porcelain = " M .flow/tasks/_TEMPLATE.md\n M src/app.ts\n?? README.md\n";
  assert.deepEqual(findUncommittedTasks(porcelain), []);
});

test("findUncommittedTasks: a staged deletion (not on disk) is filtered out by `files`", () => {
  // The task was committed-then-deleted: porcelain reports it, but it's not in the on-disk set.
  assert.deepEqual(findUncommittedTasks("D  .flow/tasks/0001-gone.md\n", [".flow/tasks/0002-here.md"]), []);
});

test("runDoctor: an uncommitted task file (injected git status) is a PROBLEM", () => {
  const d = fixture({ "0099-x.md": task("P-0099") });
  const gitStatus = () => ({ inRepo: true, porcelain: "?? .flow/tasks/0099-x.md\n" });
  const r = runDoctor({ flowDir: d, gitStatus });
  assert.ok(r.problems.some((p) => p.includes("0099-x.md") && p.includes("not committed")));
  cleanup(d);
});

test("runDoctor: clean git status → no uncommitted-task problem, no skip note", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: true, porcelain: "" }) });
  assert.deepEqual(r.problems, []);
  assert.ok(!r.notes.some((n) => n.includes("uncommitted-task check skipped")));
  cleanup(d);
});

test("runDoctor: outside a git work tree → uncommitted-task check is skipped (a note, not a failure)", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: false, porcelain: "" }) });
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.some((n) => n.includes("uncommitted-task check skipped")));
  cleanup(d);
});

// ── readiness bar: the body shape a `ready` task must have (flow-0010) ──
// The bar `task-writer` is supposed to enforce, re-applied where it can't be skipped. Every
// test here is the "skipped task-writer" shape: legal frontmatter, unspecified body.

const NO_CRITERIA = `
## Context

Why.

## Scope

What.
`;

test("ready task with no ## Acceptance criteria section → PROBLEM naming the task and the section", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { body: NO_CRITERIA }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("## Acceptance criteria")),
    `expected a missing-criteria PROBLEM, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("ready task whose Acceptance criteria section has no `- [ ]` items → PROBLEM", () => {
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

It should work well and feel fast.
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes('no "- [ ]" items')));
  cleanup(d);
});

test("ready task whose only criteria are _TEMPLATE.md's placeholders → PROBLEM", () => {
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

- [ ] Given <situation>, when <action>, then <observable outcome>.
- [ ] …
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("placeholders")),
    `an uncustomised template is not a specified task, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("ready task missing ## Context or ## Scope → PROBLEM naming which section is absent", () => {
  const noScope = `
## Context

Why.

## Acceptance criteria

- [ ] Given a store, when the doctor runs, then it reports drift.
`;
  const noContext = `
## Scope

What.

## Acceptance criteria

- [ ] Given a store, when the doctor runs, then it reports drift.
`;
  const d = fixture({
    "0001-a.md": task("P-0001", { body: noScope }),
    "0002-b.md": task("P-0002", { body: noContext }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes('"## Scope"')));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes('"## Context"')));
  assert.ok(!r.problems.some((p) => p.includes("P-0001") && p.includes('"## Context"')),
    "the finding must name the section that is actually absent");
  cleanup(d);
});

test("ready task with all sections and one real criterion → no new problem or warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("a criterion that merely quotes an <angle-bracket> token is real, not a placeholder", () => {
  // This task's own criteria quote `### G<n> — ` — "contains a <slot>" must not read as unedited.
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

- [ ] Given a heading \`### G<n> — <title>\`, when the extractor runs, then the id is returned.
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  cleanup(d);
});

test("body absent entirely (frontmatter only) on a ready task → PROBLEM, not a throw", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { body: "" }) });
  const r = runDoctor({ flowDir: d });                       // must not throw
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("empty body")),
    `expected an empty-body PROBLEM, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("body-shape checks do NOT fire for in_progress / in_review / done / blocked tasks", () => {
  // The bar applies where a task is offered to a worker. flow-doctor fails store-wide, so a
  // retroactive rule would redden every open PR in the repo, including PRs that can't fix it.
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-08-18", body: "" }),
    "0002-b.md": task("P-0002", { status: "in_review", branch: "flow/P-0002-x", pr: "http://pr/2", body: "" }),
    "0003-c.md": task("P-0003", { status: "done", body: "" }),
    "0004-d.md": task("P-0004", { status: "blocked", blocked_reason: "needs a decision", body: "" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "no body-shape problem may fire outside `ready`");
  assert.ok(!r.warnings.some((w) => w.includes("Acceptance criteria") || w.includes("empty body")));
  cleanup(d);
});

test("readinessFindings: pure, and returns one finding per absent section", () => {
  assert.deepEqual(readinessFindings({ id: "P-1", body: READY_BODY }), []);
  const bare = readinessFindings({ id: "P-1", body: "" });
  assert.equal(bare.length, 1);
  assert.ok(bare[0].includes("empty body"));
  assert.equal(readinessFindings({ id: "P-1", body: "## Notes\n\nnothing\n" }).length, 3);
});

// ── new-subsystem tell (a task that stands up a tree the repo doesn't have) ──

test("touches rooted at a top-level dir that doesn't exist → WARNING, never a problem", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { touches: '["mobile/**", "mobile/app/index.tsx"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const hits = r.warnings.filter((w) => w.includes("mobile/") && w.includes("subsystem"));
  assert.equal(hits.length, 1, "one warning per missing root, not one per glob");
  cleanup(d);
});

test("new-subsystem tell exempts ROOT_IGNORE dirs and globs with no directory component", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '[".github/workflows/flow-gates.yml", "CLAUDE.md", ".flow/bin/x.mjs"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("subsystem")),
    `Flow's own plumbing and root files are not new subsystems, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

// ── vision-serves: a ready task must name the goal it advances (flow-0010) ──

test("no VISION.md → exactly one warning, no per-task serves finding, and exit-0 shape", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { serves: "[]" }),
    "0002-b.md": task("P-0002", { serves: '["G404"]' }),
  }, { vision: null });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "an adopting repo without a vision stays green");
  const vision = r.warnings.filter((w) => w.includes("VISION.md"));
  assert.equal(vision.length, 1, `expected one vision-inactive warning, got ${JSON.stringify(r.warnings)}`);
  assert.ok(vision[0].includes("inactive"));
  assert.ok(!r.warnings.some((w) => w.includes("serves")  && w.includes("P-0002")));
  cleanup(d);
});

test("VISION.md present + ready task with missing or empty serves → PROBLEM naming the task", () => {
  const noField = task("P-0002").replace(/^serves:.*$/m, "");
  const d = fixture({ "0001-a.md": task("P-0001", { serves: "[]" }), "0002-b.md": noField });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("no serves")));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes("no serves")));
  cleanup(d);
});

test("serves naming an unknown id, or a non-goal, is a PROBLEM in each case", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { serves: '["G404"]' }),
    "0002-b.md": task("P-0002", { serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("does not declare")));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes("NON-GOAL")),
    "a task advancing a declared non-goal is drift with a paper trail");
  cleanup(d);
});

test("serves naming a retired goal → WARNING, not a problem", () => {
  // `status` is explicit rather than leaning on the fixture default. The retired-goal warning is
  // now status-dependent (see below), so a test that let the default supply the status would
  // silently change meaning the day that default moved — the failure mode where a test keeps
  // passing while no longer proving what its name claims.
  const d = fixture({ "0001-a.md": task("P-0001", { status: "ready", serves: '["G9"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")));
  cleanup(d);
});

test("a DONE task serving a retired goal is silent — the warning has no remedy it could take", () => {
  // Finished work cannot be dropped, and `serves` records the goal the task was WRITTEN to
  // advance, so it cannot honestly be re-anchored either. Warning about it asks the reader to
  // falsify history, and at volume it buries the live tasks that can still act on the advice.
  const d = fixture({ "0001-a.md": task("P-0001", { status: "done", serves: '["G9"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(!r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")),
    "a done task serving a retired goal should not warn");
  cleanup(d);
});

test("every non-done status still warns on a retired goal", () => {
  // The exemption is `done` and only `done`. Each of these is still live, and at least one of the
  // two remedies — dropping the task — remains a real call for the reader, so the line earns its
  // place. Table-driven so adding a status to the lifecycle surfaces here rather than silently
  // inheriting the exemption.
  for (const status of ["ready", "in_progress", "in_review", "blocked"]) {
    const d = fixture({
      "0001-a.md": task("P-0001", {
        status,
        serves: '["G9"]',
        // in_progress/in_review are only well-formed with a claim on them; without these the
        // store would fail for an unrelated reason and mask what this test is asking.
        owner: status === "ready" || status === "blocked" ? "" : "session_x",
        started: status === "ready" || status === "blocked" ? "" : "2026-09-14T02:10:04Z",
        blocked_reason: status === "blocked" ? "waiting on something" : "",
      }),
    });
    const r = runDoctor({ flowDir: d });
    assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")),
      `status "${status}" should still warn on a retired goal`);
    cleanup(d);
  }
});

test("the done exemption does not leak to the sibling serves branches", () => {
  // An aged anchor is forgivable; a broken or self-contradicting one is not. An id VISION.md never
  // declared, or one it declares a NON-GOAL, still reports on finished work — those say the record
  // is wrong, not merely old. (On a non-ready task they report as warnings, which is the existing
  // severity rule and deliberately left alone.)
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "done", serves: '["G404"]' }),
    "0002-b.md": task("P-0002", { status: "done", serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  const all = [...r.problems, ...r.warnings];
  assert.ok(all.some((m) => m.includes("P-0001") && m.includes("does not declare")),
    "a done task naming an undeclared goal id must still report");
  assert.ok(all.some((m) => m.includes("P-0002") && m.includes("NON-GOAL")),
    "a done task naming a declared non-goal must still report");
  cleanup(d);
});

test('serves: ["maintenance"] reports nothing and looks nothing up', () => {
  // The fixture VISION.md declares no goal called "maintenance" — so a silent run is the proof
  // that the reserved id short-circuits before the lookup, not that the lookup happened to hit.
  const d = fixture({ "0001-a.md": task("P-0001", { serves: '["maintenance"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("non-ready tasks: empty serves is silent, and a bad id warns instead of failing", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "done", serves: "[]" }),
    "0002-b.md": task("P-0002", { status: "in_progress", owner: "s", started: "2026-08-18", serves: '["G404"]' }),
    "0003-c.md": task("P-0003", { status: "blocked", blocked_reason: "waiting", serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "adopting the check must not retroactively fail history");
  assert.ok(!r.warnings.some((w) => w.includes("P-0001") && w.includes("serves")));
  assert.ok(r.warnings.some((w) => w.includes("P-0002") && w.includes("does not declare")));
  assert.ok(r.warnings.some((w) => w.includes("P-0003") && w.includes("NON-GOAL")));
  cleanup(d);
});

test("a VISION.md with zero extractable goals → repo-level PROBLEM naming the heading format", () => {
  const d = fixture({ "0001-a.md": task("P-0001") }, { vision: "# Vision\n\n## Goals\n\n* Be good\n* Be fast\n" });
  const r = runDoctor({ flowDir: d });
  const fmt = r.problems.filter((p) => p.includes("VISION.md declares no goals"));
  assert.equal(fmt.length, 1, `expected the format problem, got ${JSON.stringify(r.problems)}`);
  assert.ok(fmt[0].includes("### G<n>"));
  assert.ok(!r.problems.some((p) => p.includes("P-0001")),
    "with no goals extractable, per-task serves checks would be vacuous — report the format once instead");
  cleanup(d);
});

test("goal headings: hyphen and en-dash separators still extract; a malformed one warns by name", () => {
  const vision = `# Vision

## Goals

### G1 — Em dash
### G2 - Hyphen
### G3 – En dash
### G4 No separator at all
`;
  const d = fixture({ "0001-a.md": task("P-0001", { serves: '["G2", "G3"]' }) }, { vision });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "G2 and G3 must resolve — a mistyped dash can't drop a goal");
  assert.ok(r.warnings.some((w) => w.includes("G4 No separator at all") && w.includes("### G<n>")),
    `one mistyped heading must not vanish silently, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("parseVisionGoals: ids, kinds, retirement — by line regex, never a Markdown parser", () => {
  const { goals, malformed } = parseVisionGoals(VISION);
  assert.deepEqual([...goals.keys()], ["G1", "G2", "NG1", "G9"]);
  assert.equal(goals.get("G1").kind, "goal");
  assert.equal(goals.get("G1").title, "Ship the thing");
  assert.equal(goals.get("NG1").kind, "non-goal");
  assert.equal(goals.get("G9").retired, true);
  assert.equal(goals.get("G1").retired, false);
  assert.deepEqual(malformed, []);
});

// ── the CLI contract: PROBLEM exits 1, WARNING exits 0 ──
// Run the real CLI over a fixture store, because the exit code is the half of the bar CI
// actually reads — `runDoctor` returning findings proves nothing if the process exits 0.

function cliFixture(files, opts) {
  const flowDir = fixture(files, opts);
  mkdirSync(join(flowDir, "bin"), { recursive: true });
  for (const f of ["flow-doctor.mjs", "apply-board-edits.mjs"])
    copyFileSync(join(import.meta.dirname, f), join(flowDir, "bin", f));
  return flowDir;
}
function runCli(flowDir) {
  // spawnSync, not execFileSync: warnings are written to stderr and the run still exits 0,
  // so a stdout-only reader would see an empty page and call the check silent.
  const r = spawnSync("node", [join(flowDir, "bin", "flow-doctor.mjs")], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("CLI: an unready ready-task exits 1 and names the task", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { body: "" }) });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*P-0001/);
  cleanup(d);
});

test("CLI: warnings alone (new subsystem, no vision) still exit 0", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { touches: '["mobile/**"]', serves: "[]" }) }, { vision: null });
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.match(out, /WARN.*subsystem/);
  cleanup(d);
});

// ── blocked_by: the machine-readable half of blocked_reason (flow-0040) ──
// The line the whole check is drawn on: the ONLY finding a store written before this field can
// trip is a warning. Every PROBLEM below needs a populated `blocked_by` to fire, and a task
// that predates the field has none — so adoption cannot turn an already-adopted repo red.

// `yaml` is a real YAML parser, and this is the one assertion that wants one — but NOTHING else
// under `project-template/.flow/bin/` imports a non-`node:` module, deliberately: this tree is
// copied into repos that may not be JavaScript projects at all, and canonical's own config.yml
// names the rule ("every dependency added here is a dependency imposed downstream"). So the
// parser is loaded OPTIONALLY. Canonical has it, so the strict parse runs on every gate run here
// — which is where `_TEMPLATE.md` is authored and where a break would be introduced. A consuming
// repo without it still gets the flow-doctor-parser half below, which is the reader that
// actually matters there.
const yamlParse = await import("yaml").then((m) => m.parse, () => null);

test("_TEMPLATE.md ships blocked_by as an empty list, and still parses", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "tasks", "_TEMPLATE.md"), "utf8");

  if (yamlParse) {
    const parsed = yamlParse(text.slice(3, text.indexOf("\n---", 3)));
    assert.ok(Object.hasOwn(parsed, "blocked_by"), "the published template must declare the field");
    assert.deepEqual(parsed.blocked_by, [], "it ships empty — absent means 'not declared'");
    assert.equal(parsed.status, "ready", "the rest of the frontmatter must survive the addition");
  }

  // The other reader, and the one every consuming repo runs: flow-doctor's own frontmatter scan.
  // Proving both agree beats trusting that a YAML-valid file is also parseListField-valid.
  const d = fixture({ "0001-a.md": text.replace('id: "PROJ-0000"', 'id: "P-0001"') });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems.filter((x) => x.includes("blocked_by")), [],
    `the shipped template must be clean under the check it ships with, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("blocked with a blocked_by naming a task id → reported as nothing at all", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on P-0002", blocked_by: '["P-0002"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("blocked_by")), [],
    `a fully declared block is the good case, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("blocked with a blocked_by naming a PR url → also clean", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on #51",
      blocked_by: '["https://github.com/o/r/pull/51"]' }),
  });
  assert.deepEqual(runDoctor({ flowDir: d }).problems, []);
  cleanup(d);
});

test("blocked with an EMPTY blocked_by → WARNING that names the way out", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on something", blocked_by: "[]" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "criterion 6: a repo full of pre-field blocked tasks must not go red");
  const w = r.warnings.filter((x) => x.includes("P-0001") && x.includes("blocked_by"));
  assert.equal(w.length, 1, `expected one nudge, got ${JSON.stringify(r.warnings)}`);
  assert.match(w[0], /task id or PR url/, "the message has to say how to make the block machine-checkable");
  assert.match(w[0], /not machine-checkable/, "…and name the opt-out for a block that genuinely isn't");
  cleanup(d);
});

test('blocked_reason saying "not machine-checkable" silences the nudge', () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_by: "[]",
      blocked_reason: "Waiting on the client's lawyer to call back - not machine-checkable." }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("blocked_by")), [],
    "a declared-unmechanical block is answered, not nagged");
  cleanup(d);
});

test("ready with a populated blocked_by → PROBLEM: a dependency that outlived its block", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "ready", blocked_by: '["P-0002"]' }) });
  const r = runDoctor({ flowDir: d });
  const p = r.problems.filter((x) => x.includes("P-0001") && x.includes("blocked_by"));
  assert.equal(p.length, 1, `expected the stale-dependency problem, got ${JSON.stringify(r.problems)}`);
  assert.match(p[0], /stale data/);
  assert.match(p[0], /P-0002/, "name the dependency, so the reader knows what to delete");
  cleanup(d);
});

test("in_progress and in_review are live too — a leftover blocked_by is stale there as well", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-09-01T10:00:00Z",
      blocked_by: '["P-0009"]' }),
    "0002-b.md": task("P-0002", { status: "in_review", branch: "flow/x", pr: "https://github.com/o/r/pull/2",
      touches: '["api/**"]', blocked_by: '["P-0009"]' }),
  }, { dirs: ["src", "api"] });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((x) => x.includes("P-0001") && x.includes("stale data")));
  assert.ok(r.problems.some((x) => x.includes("P-0002") && x.includes("stale data")));
  cleanup(d);
});

test("done keeps its blocked_by — there it is history, not drift", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "done", blocked_by: '["P-0002"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "clearing a done task's record of what it waited on destroys the record");
  cleanup(d);
});

test("a malformed blocked_by entry → PROBLEM naming the entry", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting",
      blocked_by: '["P-0002", "the PR Dan opened last week"]' }),
  });
  const r = runDoctor({ flowDir: d });
  const p = r.problems.filter((x) => x.includes("malformed"));
  assert.equal(p.length, 1, `only the bad entry is malformed, got ${JSON.stringify(r.problems)}`);
  assert.match(p[0], /the PR Dan opened last week/);
  assert.match(p[0], /task id .* or a PR url/);
  cleanup(d);
});

test("blocked_by in the multi-line list form is read, not silently seen as empty", () => {
  // parseListField's older sibling bug: a naive same-line scan reads the block form as empty,
  // which would silence the stale-dependency PROBLEM entirely.
  const body = `---
id: "P-0001"
title: "x"
status: "ready"
priority: 3
blocked_reason: ""
blocked_by:
  - "P-0002"
  - "https://github.com/o/r/pull/7"
serves: ["G1"]
touches: ["src/**"]
---
${READY_BODY}`;
  const d = fixture({ "0001-a.md": body });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((x) => x.includes("P-0002") && x.includes("stale data")),
    `the block form must parse, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("isBlockedByEntry: the shape contract, stated once", () => {
  for (const ok of ["P-0002", "flow-0040", "write_2-17", "https://github.com/o/r/pull/51", " P-0002 "])
    assert.equal(isBlockedByEntry(ok), true, ok);
  for (const bad of ["", "P-", "0002", "-0002", "P 0002", "github.com/o/r/pull/51", "ftp://x/y", "P-0002 and P-0003"])
    assert.equal(isBlockedByEntry(bad), false, JSON.stringify(bad));
  assert.equal(isBlockedByEntry(undefined), false);
});

test("blockedByFindings: an absent blocked_by is 'not declared', never an error", () => {
  // Criterion 6 at unit level: the pre-field shape of every task in every adopted repo.
  for (const status of ["ready", "in_progress", "in_review", "done", "blocked"]) {
    const f = blockedByFindings({ id: "P-1", status, blocked_reason: "r" });
    assert.deepEqual(f.problems, [], status);
    if (status !== "blocked") assert.deepEqual(f.warnings, [], status);
  }
});

test("a store that predates blocked_by entirely gets the same verdict as before — CLI exit 0", () => {
  const d = cliFixture({
    "0001-a.md": task("P-0001"),
    "0002-b.md": task("P-0002", { status: "blocked", blocked_reason: "waiting on a decision", touches: '["api/**"]' }),
    "0003-c.md": task("P-0003", { status: "done", touches: '["docs/**"]' }),
  }, { dirs: ["src", "api", "docs"] });
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /FAIL/, "adopting the field must not fail a repo that has never used it");
  assert.match(out, /WARN.*P-0002.*blocked_by/, "it may nudge — a nudge is exit 0");
  cleanup(d);
});

test("CLI: a stale blocked_by exits 1 — the PROBLEM half is really a PROBLEM", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { blocked_by: '["P-0002"]' }) });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*P-0001/);
  cleanup(d);
});
