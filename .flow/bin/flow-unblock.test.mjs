// Tests for flow-unblock — the blocked-task release sweep (flow-0041). Zero-dep, node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  classifyBlocked, resolveEntry, parsePrUrl, buildReleaseEdit, planReleases, prRefs,
  parsePrFacts, readTasks, shouldDispatch, countActiveRuns, httpStatusOf, dispatchOutcome,
  runUnblockCli,
} from "./flow-unblock.mjs";
import { applyEdits } from "./apply-board-edits.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const PR = "https://github.com/o/r/pull/7";
const PR2 = "https://github.com/o/r/pull/8";

// The criteria are stated against the classifier as the workflow drives it: store + PR facts in,
// one decision per blocked task out. So most tests go through planReleases with a real resolution,
// rather than handing classifyBlocked a pre-chewed list it could not get wrong.
const decide = (tasks, facts = new Map()) =>
  Object.fromEntries(planReleases(tasks, facts).map((p) => [p.id, p.decision]));
const blocked = (id, blockedBy) => ({ id, status: "blocked", blockedBy });

// ── classifier: the criteria ────────────────────────────────────────────────────────────

test("a blocked task whose only blocked_by names a done task is released", () => {
  const d = decide([blocked("P-2", ["P-1"]), { id: "P-1", status: "done", blockedBy: [] }]);
  assert.equal(d["P-2"], "release");
});

test("a blocked task whose only blocked_by names a task that is not done stays blocked", () => {
  for (const status of ["ready", "in_progress", "in_review", "blocked"]) {
    const d = decide([blocked("P-2", ["P-1"]), { id: "P-1", status, blockedBy: [] }]);
    assert.equal(d["P-2"], "waiting", `dependency ${status}`);
  }
});

test("two blocked_by entries of which only one is satisfied keep the task blocked", () => {
  const tasks = [blocked("P-3", ["P-1", PR]), { id: "P-1", status: "done", blockedBy: [] }];
  assert.equal(decide(tasks, new Map([[PR, { state: "open", merged: false }]]))["P-3"], "waiting");
  // and the other way round: the PR merged, the task is not done
  const tasks2 = [blocked("P-3", ["P-1", PR]), { id: "P-1", status: "in_review", blockedBy: [] }];
  assert.equal(decide(tasks2, new Map([[PR, { state: "closed", merged: true }]]))["P-3"], "waiting");
  // both satisfied: released
  const tasks3 = [blocked("P-3", ["P-1", PR]), { id: "P-1", status: "done", blockedBy: [] }];
  assert.equal(decide(tasks3, new Map([[PR, { state: "closed", merged: true }]]))["P-3"], "release");
});

test("a blocked task whose blocked_by names a merged PR is released", () => {
  const d = decide([blocked("P-2", [PR])], new Map([[PR, { state: "closed", merged: true }]]));
  assert.equal(d["P-2"], "release");
  // A trailing slash is the same PR.
  const d2 = decide([blocked("P-2", [PR + "/"])], new Map([[PR, { state: "closed", merged: true }]]));
  assert.equal(d2["P-2"], "release");
});

test("a PR closed without merging keeps the task blocked, distinguishably from not-yet-resolved", () => {
  const closed = decide([blocked("P-2", [PR])], new Map([[PR, { state: "closed", merged: false }]]));
  const open = decide([blocked("P-2", [PR])], new Map([[PR, { state: "open", merged: false }]]));
  assert.equal(closed["P-2"], "closed-unmerged");
  assert.equal(open["P-2"], "waiting");
  assert.notEqual(closed["P-2"], open["P-2"]);
  // It outranks a pending sibling: waiting for the open PR can never release this task.
  const both = decide([blocked("P-2", [PR, PR2])],
    new Map([[PR, { state: "open", merged: false }], [PR2, { state: "closed", merged: false }]]));
  assert.equal(both["P-2"], "closed-unmerged");
  // And the plan line names the abandoned PR, which is what the workflow surfaces.
  const [line] = planReleases([blocked("P-2", [PR])], new Map([[PR, { state: "closed", merged: false }]]));
  assert.match(line.detail, new RegExp(`${PR}=closed-unmerged`));
});

test("an empty or absent blocked_by is never released — only a human may lift it", () => {
  assert.equal(decide([blocked("P-2", [])])["P-2"], "unreadable");
  assert.equal(decide([{ id: "P-2", status: "blocked" }])["P-2"], "unreadable");
  assert.equal(decide([blocked("P-2", ["", "  "])])["P-2"], "unreadable");
  assert.equal(classifyBlocked({ status: "blocked" }, []), "unreadable");
});

test("a task that is not blocked is never released, whatever its blocked_by holds", () => {
  const facts = new Map([[PR, { state: "closed", merged: true }]]);
  for (const status of ["ready", "in_progress", "in_review", "done", ""]) {
    assert.equal(classifyBlocked({ status, blockedBy: [PR] }, ["satisfied"]), "not-blocked", status);
    const plan = planReleases([{ id: "P-2", status, blockedBy: [PR] }], facts);
    assert.deepEqual(plan, [], `a ${status || "statusless"} task must not even be planned`);
  }
  assert.equal(classifyBlocked(null), "not-blocked");
});

// ── classifier: everything it cannot read keeps the block ───────────────────────────────

test("anything unresolvable keeps the task blocked: dangling id, malformed entry, foreign url, unread PR", () => {
  const facts = new Map([[PR, "unknown"]]);
  for (const entry of ["P-404", "not an entry", "https://example.com/x", PR,
                       "https://github.com/o/r/pull/7?x=1", "https://github.com/o/r/issues/7"]) {
    assert.equal(decide([blocked("P-2", [entry])], facts)["P-2"], "waiting", entry);
  }
  assert.equal(resolveEntry("P-1"), "unknown");
  assert.equal(resolveEntry(PR, { prFacts: new Map([[PR, { state: "weird", merged: false }]]) }), "unknown");
  // a short resolution list is never read as "all satisfied"
  assert.equal(classifyBlocked(blocked("P-2", ["P-1", "P-3"]), ["satisfied"]), "waiting");
  assert.equal(classifyBlocked(blocked("P-2", ["P-1"]), null), "waiting");
});

test("parsePrUrl accepts only a plain GitHub PR url, normalised", () => {
  assert.deepEqual(parsePrUrl(PR + "/"), { url: PR, repo: "o/r", number: 7 });
  for (const bad of ["https://github.com/o/r/pull/7/files", "http://github.com/o/r/pull/7",
                     "https://github.com/../r/pull/7", "https://github.com/o/r/pull/x", "", null,
                     "https://github.com/o/r;rm/pull/7"]) {
    assert.equal(parsePrUrl(bad), null, String(bad));
  }
});

test("the release edit is ready + cleared fields, never in_progress", () => {
  assert.deepEqual(buildReleaseEdit("P-2"), { id: "P-2", status: "ready", blocked_reason: "", blocked_by: [] });
});

// ── PR refs and facts ───────────────────────────────────────────────────────────────────

test("prRefs asks only about PR entries of blocked tasks, deduped", () => {
  const refs = prRefs([blocked("P-1", [PR, "P-9", PR + "/"]), blocked("P-2", [PR2]),
                       { id: "P-3", status: "done", blockedBy: ["https://github.com/o/r/pull/99"] }]);
  assert.deepEqual(refs.map((r) => r.url), [PR, PR2]);
});

test("parsePrFacts reads state/merged lines and drops anything malformed", () => {
  const facts = parsePrFacts(`${PR}\tclosed\ttrue\n${PR2}\tunknown\t\n` +
    "https://github.com/o/r/pull/9\tmaybe\ttrue\nnot-a-url\topen\tfalse\n\n");
  assert.deepEqual(facts.get(PR), { state: "closed", merged: true });
  assert.equal(facts.get(PR2), "unknown");
  assert.equal(facts.has("https://github.com/o/r/pull/9"), false);
  assert.equal(facts.size, 2);
});

// ── the dispatch decision ───────────────────────────────────────────────────────────────

test("dispatches with ready work, no active runner and FLOW_QUEUE_RUNNER unset", () => {
  assert.equal(shouldDispatch({ ready: 1, activeRuns: 0, queueRunner: "" }).dispatch, true);
  assert.equal(shouldDispatch({ ready: 3, activeRuns: 0 }).dispatch, true);
});

test("each of the three conditions false on its own stops the dispatch", () => {
  const base = { ready: 1, activeRuns: 0, queueRunner: "" };
  const cases = {
    "no ready task": { ...base, ready: 0 },
    "a runner already active": { ...base, activeRuns: 1 },
    "FLOW_QUEUE_RUNNER paused": { ...base, queueRunner: "paused" },
    "run count unknown": { ...base, activeRuns: "unknown" },
  };
  for (const [name, input] of Object.entries(cases)) {
    const d = shouldDispatch(input);
    assert.equal(d.dispatch, false, name);
    assert.ok(d.reason, `${name} must say why`);
  }
  // any other value of the switch is not a pause
  assert.equal(shouldDispatch({ ...base, queueRunner: "on" }).dispatch, true);
});

test("countActiveRuns counts every unfinished run and reports an unreadable list as unknown", () => {
  const runs = [{ status: "queued" }, { status: "waiting" }, { status: "in_progress" },
                { status: "pending" }, { status: "completed" }];
  assert.equal(countActiveRuns(JSON.stringify(runs)), 4);
  assert.equal(countActiveRuns("[]"), 0);
  assert.equal(countActiveRuns("HTTP 403"), "unknown");
  assert.equal(countActiveRuns('{"a":1}'), "unknown");
});

test("a 403 on dispatch is a warning naming actions: write, never a failure", () => {
  const out = "gh: Resource not accessible by integration (HTTP 403)";
  assert.equal(httpStatusOf(out), 403);
  const line = dispatchOutcome(1, out, "flow-queue-runner.yml");
  assert.match(line, /^::warning::/);
  assert.match(line, /actions: write/);
  assert.match(dispatchOutcome(1, "HTTP 404"), /^::warning::.*404/);
  assert.match(dispatchOutcome(1, "network down"), /^::warning::/);
  assert.match(dispatchOutcome(0, ""), /^Dispatched flow-queue-runner\.yml with no task_id/);
  // The CLI that the step pipes into exits 0 on the 403 — that exit code is the step's.
  const r = spawnSync(process.execPath, [join(BIN, "flow-unblock.mjs"), "dispatch-outcome", "1", "flow-queue-runner.yml"],
    { input: out, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::warning::.*actions: write/);
});

// ── the CLI, end to end over a real store ───────────────────────────────────────────────

function store() {
  const dir = mkdtempSync(join(tmpdir(), "flow-unblock-"));
  const t = (name, body) => writeFileSync(join(dir, name), body);
  t("0001-a.md", '---\nid: "P-0001"\nstatus: "done"\nblocked_by: []\n---\n');
  t("0002-b.md", '---\nid: "P-0002"\nstatus: "blocked"\nowner: "w"\n' +
    'blocked_reason: "waits on P-0001 and #7"\nblocked_by:\n  - "P-0001"\n  - "' + PR + '"\n' +
    'touches: ["a/**"]\n---\nbody\n');
  t("0003-c.md", '---\nid: "P-0003"\nstatus: "blocked"\nblocked_reason: "a call"\nblocked_by: []\n---\n');
  t("0004-d.md", '---\nid: "P-0004"\nstatus: "blocked"\nblocked_reason: "x"\nblocked_by: ["' + PR2 + '"]\n---\n');
  t("0005-e.md", '---\nid: "P-0005"\nstatus: "ready"\n---\n');
  t("_TEMPLATE.md", '---\nid: "P-0000"\nstatus: "blocked"\nblocked_by: ["P-0001"]\n---\n');
  return dir;
}
const cli = (argv, opts) => {
  let s = "";
  const code = runUnblockCli(argv, { out: { write: (x) => { s += x; } }, ...opts });
  return { code, s };
};

test("CLI: pr-refs, plan and edits agree, and the edits release exactly the resolvable task", () => {
  const dir = store();
  const factsText = `${PR}\tclosed\ttrue\n${PR2}\tclosed\tfalse\n`;
  const readFile = () => factsText;
  assert.equal(cli(["pr-refs"], { tasksDir: dir }).s, `${PR}\to/r\t7\n${PR2}\to/r\t8\n`);
  const plan = cli(["plan", "--pr-facts", "f"], { tasksDir: dir, readFile }).s;
  assert.match(plan, /^P-0002\trelease\t$/m);
  assert.match(plan, /^P-0003\tunreadable\t/m);
  assert.match(plan, new RegExp(`^P-0004\\tclosed-unmerged\\t${PR2}=closed-unmerged$`, "m"));
  assert.doesNotMatch(plan, /P-0000|P-0001|P-0005/);
  const edits = JSON.parse(cli(["edits", "--pr-facts", "f"], { tasksDir: dir, readFile }).s);
  assert.deepEqual(edits, { updates: [buildReleaseEdit("P-0002")] });

  // Without facts the PR entry is unknown and nothing is released.
  assert.deepEqual(JSON.parse(cli(["edits"], { tasksDir: dir }).s), { updates: [] });

  // Applied through the sanctioned writer: ready, cleared, nothing else changed.
  const before = readFileSync(join(dir, "0002-b.md"), "utf8");
  const { applied, problems } = applyEdits({ tasksDir: dir, updates: edits.updates });
  assert.equal(applied, 1);
  assert.deepEqual(problems, []);
  assert.equal(readFileSync(join(dir, "0002-b.md"), "utf8"),
    before.replace('status: "blocked"', 'status: "ready"')
      .replace('blocked_reason: "waits on P-0001 and #7"', 'blocked_reason: ""')
      .replace(`blocked_by:\n  - "P-0001"\n  - "${PR}"`, "blocked_by: []"));
  assert.equal(cli(["count-ready"], { tasksDir: dir }).s, "2\n");
  // A second sweep over the released store has nothing left to release.
  assert.deepEqual(JSON.parse(cli(["edits", "--pr-facts", "f"], { tasksDir: dir, readFile }).s), { updates: [] });
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: count-active-runs, should-dispatch and dispatch-outcome", () => {
  assert.equal(cli(["count-active-runs"], { stdin: () => '[{"status":"queued"}]' }).s, "1\n");
  assert.equal(cli(["count-active-runs"], { stdin: () => "" }).s, "unknown\n");
  assert.equal(cli(["should-dispatch", "--ready", "2", "--active", "0", "--queue-runner", ""]).s, "dispatch\n");
  assert.match(cli(["should-dispatch", "--ready", "2", "--active", "unknown"]).s, /^skip: /);
  assert.match(cli(["should-dispatch", "--ready", "2", "--active", "0", "--queue-runner", "paused"]).s, /^skip: .*paused/);
  assert.match(cli(["should-dispatch", "--ready", "x", "--active", "0"]).s, /^skip: no ready task/);
  assert.match(cli(["dispatch-outcome", "1", "runner.yml"], { stdin: () => "(HTTP 403)" }).s,
    /^::warning::Could not dispatch runner\.yml: HTTP 403/);
  const r = cli(["nope"]);
  assert.equal(r.code, 0);
  assert.equal(r.s, "");
});

test("the CLI block runs when invoked directly and reads the store beside it", () => {
  // The template resolves its store from its own realpath, so stage a copy with a seeded store.
  const root = mkdtempSync(join(tmpdir(), "flow-unblock-cli-"));
  mkdirSync(join(root, ".flow"), { recursive: true });
  cpSync(BIN, join(root, ".flow", "bin"), { recursive: true });
  cpSync(store(), join(root, ".flow", "tasks"), { recursive: true });
  const r = spawnSync(process.execPath, [join(root, ".flow", "bin", "flow-unblock.mjs"), "count-ready"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "1\n");
  assert.equal(readTasks(join(root, ".flow", "tasks")).length, 5);
  rmSync(root, { recursive: true, force: true });
});
