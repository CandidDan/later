// flow-state.test.mjs — node --test. Exercises the pure resolution core: parsing, PR
// matching, and every store-vs-PR resolution branch including the disagreement signals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTask, idNum, branchMatchesTask, resolveState, pickPrForTask, reconcile,
  readPrs, readTasksFromOrigin, runStateCli,
} from "./flow-state.mjs";

const task = (o) => ({ id: "CAN-1", title: "", status: "ready", owner: "", branch: "", pr: "", blocked_reason: "", issue: "", ...o });

test("parseTask reads the lifecycle fields it needs", () => {
  const text = `---\nid: "CAN-94"\ntitle: "Do the thing"\nstatus: "in_progress"\npriority: 2\nowner: "session-x"\nbranch: "flow/CAN-94-thing"\npr: "https://github.com/o/r/pull/131"\nblocked_reason: ""\nissue: "#157"\n---\nbody`;
  const t = parseTask(text);
  assert.equal(t.id, "CAN-94");
  assert.equal(t.status, "in_progress");
  assert.equal(t.owner, "session-x");
  assert.equal(t.branch, "flow/CAN-94-thing");
  assert.equal(t.pr, "https://github.com/o/r/pull/131");
  assert.equal(t.issue, "#157");
});

test("parseTask returns null without frontmatter", () => {
  assert.equal(parseTask("no frontmatter here"), null);
  assert.equal(parseTask(""), null);
});

test("idNum extracts the numeric suffix", () => {
  assert.equal(idNum("CAN-94"), 94);
  assert.equal(idNum("MEAD-0007"), 7);
  assert.equal(idNum("weird"), Infinity);
});

test("branchMatchesTask anchors on the id token (CAN-9 does not match CAN-94)", () => {
  assert.ok(branchMatchesTask("flow/CAN-94-thing", "CAN-94"));
  assert.ok(branchMatchesTask("flow/CAN-94", "CAN-94"));
  assert.ok(!branchMatchesTask("flow/CAN-9-other", "CAN-94"));
  assert.ok(!branchMatchesTask("flow/CAN-940-other", "CAN-94"));
  assert.ok(!branchMatchesTask("", "CAN-94"));
});

// ── resolveState: PR reality wins, disagreements surface ──
test("merged PR resolves to done", () => {
  const r = resolveState(task({ status: "in_review" }), { number: 5, state: "MERGED" });
  assert.equal(r.resolved, "done");
  assert.match(r.detail, /merged in #5/);
  assert.ok(r.disagreement, "in_review + merged PR should flag a writeback lag");
});

test("merged PR with store already done => no disagreement", () => {
  const r = resolveState(task({ status: "done" }), { number: 5, state: "MERGED" });
  assert.equal(r.resolved, "done");
  assert.equal(r.disagreement, null);
});

test("open PR resolves to in_review; store not in_review disagrees", () => {
  const r = resolveState(task({ status: "in_progress" }), { number: 7, state: "OPEN" });
  assert.equal(r.resolved, "in_review");
  assert.match(r.detail, /PR #7 open/);
  assert.ok(r.disagreement);
});

test("closed-unmerged PR resolves back to ready", () => {
  const r = resolveState(task({ status: "in_review" }), { number: 9, state: "CLOSED" });
  assert.equal(r.resolved, "ready");
  assert.ok(r.disagreement);
});

test("no PR + ready => unclaimed, no disagreement (the CAN-94 case)", () => {
  const r = resolveState(task({ id: "CAN-94", status: "ready" }), null);
  assert.equal(r.resolved, "ready");
  assert.match(r.detail, /unclaimed/);
  assert.equal(r.disagreement, null);
});

test("no PR + in_progress reports the owner", () => {
  const r = resolveState(task({ status: "in_progress", owner: "session-x" }), null);
  assert.equal(r.resolved, "in_progress");
  assert.match(r.detail, /session-x/);
  assert.equal(r.disagreement, null);
});

test("no PR + in_review is a disagreement (implies a PR that isn't there)", () => {
  const r = resolveState(task({ status: "in_review" }), null);
  assert.equal(r.resolved, "in_review");
  assert.ok(r.disagreement);
});

test("no PR + blocked surfaces the reason", () => {
  const r = resolveState(task({ status: "blocked", blocked_reason: "needs API key" }), null);
  assert.equal(r.resolved, "blocked");
  assert.match(r.detail, /needs API key/);
});

// ── pickPrForTask ──
test("pickPrForTask prefers an explicit pr URL match", () => {
  const t = task({ id: "CAN-3", pr: "https://github.com/o/r/pull/12", branch: "flow/CAN-3-x" });
  const prs = [
    { number: 12, state: "MERGED", headRefName: "flow/CAN-3-x", url: "https://github.com/o/r/pull/12" },
    { number: 99, state: "OPEN", headRefName: "flow/CAN-3-later", url: "https://github.com/o/r/pull/99" },
  ];
  assert.equal(pickPrForTask(t, prs).number, 12);
});

test("pickPrForTask falls back to branch match, preferring merged/open over closed", () => {
  const t = task({ id: "CAN-3", pr: "", branch: "" });
  const prs = [
    { number: 40, state: "CLOSED", headRefName: "flow/CAN-3-first", url: "u40" },
    { number: 41, state: "OPEN", headRefName: "flow/CAN-3-second", url: "u41" },
  ];
  assert.equal(pickPrForTask(t, prs).number, 41);
});

test("pickPrForTask returns null when nothing matches", () => {
  assert.equal(pickPrForTask(task({ id: "CAN-3" }), [{ number: 1, state: "OPEN", headRefName: "flow/CAN-9-x", url: "u" }]), null);
});

// ── reconcile end-to-end (pure) ──
test("reconcile sorts by id number and resolves each", () => {
  const tasks = [task({ id: "CAN-10", status: "ready" }), task({ id: "CAN-2", status: "in_progress", owner: "s" })];
  const rows = reconcile(tasks, []);
  assert.deepEqual(rows.map((r) => r.id), ["CAN-2", "CAN-10"]);
  assert.equal(rows[0].resolved, "in_progress");
  assert.equal(rows[1].resolved, "ready");
});

// ── the impure shells and the CLI function (flow-0015) ──────────────────────
// `readTasksFromOrigin`, `readPrs` and `runStateCli` became exports so canonical could adopt
// this resolver through a `.flow/bin/` adapter rather than a copy. Exported code is code
// someone else now depends on, so it gets proving tests of its own. Every fixture below is a
// real git repo built in a temp directory — the behaviour under test IS the git plumbing, and
// mocking it would prove only that the mock works.

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A repo whose `origin/main` ref exists without any network: commit, then point the
// remote-tracking ref at that commit by hand. This is exactly the state a fresh clone is in.
function repoWithOrigin(tasks) {
  const dir = mkdtempSync(join(tmpdir(), "flow-state-"));
  const tasksDir = join(dir, ".flow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (const [name, body] of Object.entries(tasks)) writeFileSync(join(tasksDir, name), body);
  writeFileSync(join(tasksDir, "_TEMPLATE.md"), `---\nid: "TEMPLATE"\nstatus: "ready"\n---\nplaceholder\n`);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "fixture");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

const fm = (id, fields = {}) =>
  `---\nid: "${id}"\ntitle: "${fields.title ?? id}"\nstatus: "${fields.status ?? "ready"}"\npriority: 2\n` +
  `owner: "${fields.owner ?? ""}"\nbranch: ""\npr: ""\nblocked_reason: ""\nissue: ""\n---\nbody\n`;

// A writable sink with the one method runStateCli uses, so the render paths are assertable.
const sink = () => { const c = []; return { write: (s) => c.push(s), text: () => c.join("") }; };

test("readTasksFromOrigin reads origin/main, NOT the working tree", () => {
  const dir = repoWithOrigin({ "a.md": fm("CAN-1", { status: "ready" }) });
  try {
    // Move the working tree on without committing. The resolver must not see this.
    writeFileSync(join(dir, ".flow", "tasks", "a.md"), fm("CAN-1", { status: "done" }));
    const { tasks, source } = readTasksFromOrigin(dir);
    assert.match(source, /^origin\/main @ /, "the authoritative layer must be named in `source`");
    assert.equal(tasks.length, 1, "_TEMPLATE.md is never a task");
    assert.equal(tasks[0].status, "ready",
      "the working tree said 'done'; origin/main said 'ready' — origin/main is the truth");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readTasksFromOrigin falls back to the working tree and SAYS SO in the contract prefix", () => {
  // No git at all — origin/main is unreadable, which is the fallback's trigger.
  const dir = mkdtempSync(join(tmpdir(), "flow-state-nogit-"));
  try {
    mkdirSync(join(dir, ".flow", "tasks"), { recursive: true });
    writeFileSync(join(dir, ".flow", "tasks", "a.md"), fm("CAN-7", { status: "blocked" }));
    const { tasks, source } = readTasksFromOrigin(dir);
    assert.equal(tasks.length, 1);
    assert.match(source, /^WORKING TREE/,
      "flightdeck-state refuses a project on this exact prefix — it is a contract, not a label");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readTasksFromOrigin returns an empty set rather than throwing when there is no store", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-state-empty-"));
  try {
    const { tasks, source } = readTasksFromOrigin(dir);
    assert.deepEqual(tasks, []);
    assert.match(source, /^WORKING TREE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readPrs degrades to a reported reason instead of throwing when gh cannot answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-state-prs-"));
  try {
    const r = readPrs(dir);
    assert.ok(Array.isArray(r.prs), "always an array — callers index it unconditionally");
    assert.equal(typeof r.ok, "boolean");
    if (!r.ok) assert.equal(typeof r.why, "string", "an unusable gh must say why, not go quiet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runStateCli --json emits the resolved rows and the provenance of the store it read", () => {
  const dir = repoWithOrigin({ "a.md": fm("CAN-1"), "b.md": fm("CAN-2", { status: "in_progress", owner: "s" }) });
  try {
    const out = sink();
    assert.equal(runStateCli({ repoRoot: dir, argv: ["--json", "--no-pr"], out }), 0);
    const payload = JSON.parse(out.text());
    assert.match(payload.source, /^origin\/main @ /);
    assert.equal(payload.prReconciled, false);
    assert.equal(payload.prNote, "skipped (--no-pr)");
    assert.deepEqual(payload.tasks.map((t) => t.id), ["CAN-1", "CAN-2"]);
    assert.equal(payload.tasks[1].resolved, "in_progress");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runStateCli resolves the repo root it is GIVEN, not the one it lives in", () => {
  // The whole reason canonical can adapt this file instead of copying it.
  const a = repoWithOrigin({ "a.md": fm("AAA-1") });
  const b = repoWithOrigin({ "b.md": fm("BBB-9") });
  try {
    const outA = sink(), outB = sink();
    runStateCli({ repoRoot: a, argv: ["--json", "--no-pr"], out: outA });
    runStateCli({ repoRoot: b, argv: ["--json", "--no-pr"], out: outB });
    assert.deepEqual(JSON.parse(outA.text()).tasks.map((t) => t.id), ["AAA-1"]);
    assert.deepEqual(JSON.parse(outB.text()).tasks.map((t) => t.id), ["BBB-9"]);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("runStateCli renders a human table and surfaces disagreements as warnings", () => {
  // in_review with no PR is the lagged-writeback signal the resolver exists to expose.
  const dir = repoWithOrigin({ "a.md": fm("CAN-4", { status: "in_review" }) });
  try {
    const out = sink();
    assert.equal(runStateCli({ repoRoot: dir, argv: ["--no-pr"], out }), 0);
    const text = out.text();
    assert.match(text, /state source: origin\/main @ /);
    assert.match(text, /PR reconcile: off — skipped \(--no-pr\)/);
    assert.match(text, /CAN-4\s+in_review/);
    assert.match(text, /⚠ CAN-4: store says 'in_review' but no open PR was found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runStateCli narrows to a single task when given an id", () => {
  const dir = repoWithOrigin({ "a.md": fm("CAN-1"), "b.md": fm("CAN-2") });
  try {
    const out = sink();
    runStateCli({ repoRoot: dir, argv: ["--json", "--no-pr", "CAN-2"], out });
    assert.deepEqual(JSON.parse(out.text()).tasks.map((t) => t.id), ["CAN-2"]);

    const miss = sink();
    assert.equal(runStateCli({ repoRoot: dir, argv: ["--no-pr", "CAN-99"], out: miss }), 0);
    assert.match(miss.text(), /No task 'CAN-99' found on origin\/main/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runStateCli reports an empty store plainly and still exits 0", () => {
  const dir = repoWithOrigin({});
  try {
    const out = sink();
    assert.equal(runStateCli({ repoRoot: dir, argv: ["--no-pr"], out }), 0);
    assert.match(out.text(), /No tasks found\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runStateCli --fetch is tolerated when there is no reachable remote", () => {
  // A sandbox has no auth; the fetch must fail silently and the read must still happen.
  const dir = repoWithOrigin({ "a.md": fm("CAN-1") });
  try {
    const out = sink();
    assert.equal(runStateCli({ repoRoot: dir, argv: ["--json", "--no-pr", "--fetch"], out }), 0);
    assert.deepEqual(JSON.parse(out.text()).tasks.map((t) => t.id), ["CAN-1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
