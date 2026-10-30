// Tests for flow-dispatch — the routine dispatcher (flow-0182). Zero-dep, node:test.
//
// Every criterion is driven through `dispatch` the way the workflow drives it: a real store on disk
// in, a stubbed fire endpoint, one decision line out. The stub records every request, so "nothing
// is POSTed" is asserted from what reached the endpoint, not inferred from the exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_VERSION, DEFAULT_MAX_IN_PROGRESS, decisionLine, dispatch, fireUrl, planDispatch,
  readLatestFromMain, readMaxInProgress, routineEnvNames, routineFor, runDispatchCli,
} from "./flow-dispatch.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
// The template's own config.yml sits next to this file's bin/ only in canonical. flow-sync copies
// this test into a consuming repo's .flow/bin/ but never that repo's config, so tests that read it
// are canonical-only (flow-0183).
const inCanonical = resolve(BIN, "..", "..", "..", "project-template", ".flow", "bin") === resolve(BIN);
const TOKEN = "sk-ant-rt-SECRET-do-not-print-0123456789";

const task = (id, { status = "ready", priority = 1, touches = [`src/${id}/**`], model = "", effort = "" } = {}) =>
  [
    "---",
    `id: "${id}"`,
    `title: "t ${id}"`,
    `status: "${status}"`,
    `priority: ${priority}`,
    "touches:",
    ...touches.map((t) => `  - "${t}"`),
    ...(model ? [`model: "${model}"`] : []),
    ...(effort ? [`effort: "${effort}"`] : []),
    ...(model || effort ? [`model_reason: "because"`] : []),
    "---",
    "",
    "body",
    "",
  ].join("\n");

function store(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "flow-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasksDir = join(dir, "tasks");
  mkdirSync(tasksDir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tasksDir, name), text);
  return { dir, tasksDir };
}

// A fire endpoint that records every request and answers with `status`.
function stubFetch(status = 200, body = '{"claude_code_session_id":"s1"}') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, fetchImpl };
}

const env = (tiers = {}) => {
  const out = {};
  for (const [tier, id] of Object.entries(tiers)) {
    const n = routineEnvNames(tier);
    out[n.id] = id;
    out[n.token] = TOKEN;
  }
  return out;
};

// Run one dispatch with captured output. `readLatest` defaults to the file on disk, which is what
// main holds in a fixture with no concurrent writer.
async function run(tasksDir, { tiers = {}, envOverride, status, body, configText = "", readLatest } = {}) {
  const out = [];
  const err = [];
  const { calls, fetchImpl } = stubFetch(status, body);
  const code = await dispatch({
    tasksDir, configText, env: envOverride ?? env(tiers), fetchImpl,
    readLatest: readLatest ?? ((file) => readFileSync(file, "utf8")),
    log: (s) => out.push(s), error: (s) => err.push(s),
  });
  const all = [...out, ...err].join("\n");
  const decisions = out.filter((l) => /^flow-dispatch: decision=/.test(l));
  return { code, out, err, all, calls, decisions };
}

// ── the criteria ────────────────────────────────────────────────────────────────────────────

test("one ready sonnet task, no in-flight work, sonnet routine set: POSTs once to the sonnet trigger and prints decision=fired", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } });

  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1, "exactly one POST");
  const [call] = r.calls;
  assert.equal(call.url, "https://api.anthropic.com/v1/claude_code/routines/trig_sonnet/fire");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.body, { text: "P-1" });
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=fired task=P-1 tier=sonnet"]);
});

test("a task with model: opus fires the opus trigger, not the sonnet one", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1", { model: "opus", effort: "high" }) });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet", opus: "trig_opus" } });

  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map((c) => c.url), [fireUrl("trig_opus")]);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=fired task=P-1 tier=opus"]);
});

test("no variable or secret for the picked task's tier: nothing POSTed, skipped no-routine-for-<tier>, exit 0", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1", { model: "opus", effort: "high" }) });

  // Neither half, only the id, only the token — each is "not configured".
  const opus = routineEnvNames("opus");
  for (const envOverride of [
    env({ sonnet: "trig_sonnet" }),
    { ...env({ sonnet: "trig_sonnet" }), [opus.id]: "trig_opus" },
    { ...env({ sonnet: "trig_sonnet" }), [opus.token]: TOKEN },
    { ...env({ sonnet: "trig_sonnet" }), [opus.id]: "  ", [opus.token]: TOKEN },
  ]) {
    const r = await run(tasksDir, { envOverride });
    assert.equal(r.code, 0, "a repo that has not set up routines stays green");
    assert.equal(r.calls.length, 0, "nothing is POSTed");
    assert.deepEqual(r.decisions, ["flow-dispatch: decision=skipped reason=no-routine-for-opus task=P-1"]);
  }
});

test("no routine configured at all exits 0 through the CLI shell too", async (t) => {
  const { dir } = store(t, { "p-1.md": task("P-1") });
  const r = spawnSync(process.execPath, [join(BIN, "flow-dispatch.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  // The template's own CLI reads the template's fixture store; what matters is exit 0 with a
  // skipped line and no routine env. The fixture-store case is asserted through runDispatchCli.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^flow-dispatch: decision=skipped reason=/m);

  const out = [];
  const code = await runDispatchCli([], { flowDir: dir, env: {}, log: (s) => out.push(s), error: () => {},
    fetchImpl: () => { throw new Error("must not be called"); } });
  assert.equal(code, 0);
  assert.deepEqual(out, ["flow-dispatch: decision=skipped reason=no-routine-for-sonnet task=P-1"]);
});

test("in_progress already at max_in_progress: nothing POSTed, skipped at-capacity", async (t) => {
  const { tasksDir } = store(t, {
    "p-1.md": task("P-1", { status: "in_progress" }),
    "p-2.md": task("P-2", { status: "in_progress" }),
    "p-3.md": task("P-3", { status: "in_progress" }),
    "p-4.md": task("P-4"),
  });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=skipped reason=at-capacity in_progress=3 max=3"]);

  // The cap is read from config: raise it and the same store fires.
  const raised = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, configText: "dispatch:\n  max_in_progress: 4\n" });
  assert.deepEqual(raised.decisions, ["flow-dispatch: decision=fired task=P-4 tier=sonnet"]);
  // …and lower it below the count: still at capacity.
  const lowered = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, configText: "dispatch:\n  max_in_progress: 1\n" });
  assert.equal(lowered.calls.length, 0);
  assert.match(lowered.decisions[0], /reason=at-capacity in_progress=3 max=1$/);
});

test("no eligible task: nothing POSTed, skipped nothing-ready", async (t) => {
  // Empty store, a store of only done/blocked work, and a ready task whose touches overlap work in review.
  const cases = [
    {},
    { "p-1.md": task("P-1", { status: "done" }), "p-2.md": task("P-2", { status: "blocked" }) },
    { "p-1.md": task("P-1", { status: "in_review", touches: ["src/**"] }), "p-2.md": task("P-2", { touches: ["src/a.js"] }) },
  ];
  for (const files of cases) {
    const { tasksDir } = store(t, files);
    const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } });
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(r.decisions, ["flow-dispatch: decision=skipped reason=nothing-ready"]);
  }
});

test("a 4xx or 5xx from the fire endpoint fails the job, names the status and the tier, and never prints the token", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1", { model: "opus", effort: "high" }) });
  for (const status of [400, 401, 404, 429, 500, 503]) {
    // A server that echoes the credential back in its error body is the worst case for a log.
    const r = await run(tasksDir, { tiers: { opus: "trig_opus" }, status, body: `{"error":"bad token ${TOKEN}"}` });
    assert.equal(r.code, 1, `HTTP ${status} must fail the job`);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.decisions, [`flow-dispatch: decision=failed reason=http task=P-1 tier=opus status=${status}`]);
    assert.match(r.all, new RegExp(`HTTP ${status}`));
    assert.match(r.all, /opus routine/);
    assert.ok(!r.all.includes(TOKEN), `the token appeared in the output for HTTP ${status}:\n${r.all}`);
    assert.ok(!r.all.includes("SECRET"), "not even a fragment of it");
  }
});

test("the token appears nowhere in the output of any run, fired, skipped or failed", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const outcomes = [
    await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } }),
    await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, status: 500, body: TOKEN }),
    await run(tasksDir, { tiers: { opus: "trig_opus" } }),
  ];
  // A network error whose message carries the token.
  const out = [];
  await dispatch({
    tasksDir, env: env({ sonnet: "trig_sonnet" }), readLatest: (f) => readFileSync(f, "utf8"),
    fetchImpl: async () => { throw new Error(`connect failed for Bearer ${TOKEN}`); },
    log: (s) => out.push(s), error: (s) => out.push(s),
  });
  assert.match(out.join("\n"), /decision=failed reason=network task=P-1 tier=sonnet/);
  for (const text of [...outcomes.map((o) => o.all), out.join("\n")]) {
    assert.ok(!text.includes(TOKEN), text);
  }
});

// ── the fail-safe rules ─────────────────────────────────────────────────────────────────────

test("never fires a task that is no longer ready on main at the moment of the call", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  for (const latest of [task("P-1", { status: "in_progress" }), task("P-1", { status: "cancelled" }), ""]) {
    const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, readLatest: () => latest });
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 0, "a task claimed since the checkout is not fired again");
    assert.match(r.decisions[0], /^flow-dispatch: decision=skipped reason=no-longer-ready task=P-1 status=/);
  }
});

test("a re-read that cannot reach main fails closed: nothing is fired", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, readLatest: () => { throw new Error("fatal: no remote"); } });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=failed reason=reread-failed task=P-1 tier=sonnet"]);
});

test("the tier comes from main's copy: a task escalated since the checkout fires its new tier", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const latest = task("P-1", { model: "opus" });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet", opus: "trig_opus" }, readLatest: () => latest });
  assert.deepEqual(r.calls.map((c) => c.url), [fireUrl("trig_opus")]);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=fired task=P-1 tier=opus"]);
  // …and when that tier has no routine, it is skipped rather than sent to the old tier's.
  const r2 = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, readLatest: () => latest });
  assert.equal(r2.calls.length, 0);
  assert.deepEqual(r2.decisions, ["flow-dispatch: decision=skipped reason=no-routine-for-opus task=P-1"]);
});

test("at most one task per run, the one pick-task chooses", async (t) => {
  const { tasksDir } = store(t, {
    "p-1.md": task("P-1", { priority: 2 }),
    "p-2.md": task("P-2", { priority: 1 }),
    "p-3.md": task("P-3", { priority: 3 }),
  });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].body, { text: "P-2" });
});

test("a routine id that could walk the URL path is refused, not sent", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  for (const id of ["../../v1/messages", "a/b", "trig?x=1", "trig sonnet"]) {
    const r = await run(tasksDir, { tiers: { sonnet: id } });
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(r.decisions, ["flow-dispatch: decision=failed reason=bad-routine-id task=P-1 tier=sonnet"]);
  }
});

test("a task whose model field is invalid fails the run rather than firing on a guess", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1", { model: "gpt" }) });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" } });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=failed reason=bad-model task=P-1"]);
});

test("a malformed max_in_progress fails the run instead of falling back", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const r = await run(tasksDir, { tiers: { sonnet: "trig_sonnet" }, configText: "dispatch:\n  max_in_progress: lots\n" });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.decisions, ["flow-dispatch: decision=failed reason=bad-config"]);
  assert.match(r.all, /max_in_progress: "lots" is not a positive whole number/);
});

test("exactly one decision line per run, whatever the outcome", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  for (const opts of [
    { tiers: { sonnet: "trig_sonnet" } },
    { tiers: { sonnet: "trig_sonnet" }, status: 502 },
    { tiers: {} },
    { tiers: { sonnet: "trig_sonnet" }, readLatest: () => task("P-1", { status: "in_progress" }) },
  ]) {
    const r = await run(tasksDir, opts);
    const lines = r.all.split("\n").filter((l) => /decision=/.test(l));
    assert.equal(lines.length, 1, lines.join("\n"));
  }
});

test("the decision line is also written to the step summary when there is one", async (t) => {
  const { dir, tasksDir } = store(t, { "p-1.md": task("P-1") });
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  await dispatch({
    tasksDir, env: { ...env({ sonnet: "trig_sonnet" }), GITHUB_STEP_SUMMARY: summary },
    fetchImpl: stubFetch().fetchImpl, readLatest: (f) => readFileSync(f, "utf8"), log: () => {}, error: () => {},
  });
  assert.equal(readFileSync(summary, "utf8"), "`flow-dispatch: decision=fired task=P-1 tier=sonnet`\n");
});

// ── the pure pieces ─────────────────────────────────────────────────────────────────────────

test("readMaxInProgress: default, set, quoted, commented, and confined to the dispatch block", () => {
  assert.equal(readMaxInProgress(""), DEFAULT_MAX_IN_PROGRESS);
  assert.equal(readMaxInProgress("project:\n  name: x\n"), 3);
  assert.equal(readMaxInProgress("dispatch:\n  max_in_progress: 5\n"), 5);
  assert.equal(readMaxInProgress('dispatch:  # c\n  max_in_progress: "2"   # two\n'), 2);
  assert.equal(readMaxInProgress("dispatch:\n  other: 1\ngit:\n  max_in_progress: 9\n"), 3,
    "a key of the same name under another block is not this one");
  for (const bad of ["0", "-1", "1.5", "three", '""']) {
    assert.throws(() => readMaxInProgress(`dispatch:\n  max_in_progress: ${bad}\n`), /positive whole number/, bad);
  }
});

test("the template's config declares the dispatch cap at the default",
  { skip: inCanonical ? false : "reads the template's config.yml, which only exists beside canonical's project-template/.flow/bin" }, () => {
  const text = readFileSync(join(BIN, "..", "config.yml"), "utf8");
  assert.equal(readMaxInProgress(text), 3);
  assert.match(text, /^dispatch:\n {2}max_in_progress: 3$/m);
});

test("readMaxInProgress: a config with no dispatch block yields the default of 3", () => {
  assert.equal(readMaxInProgress("project:\n  name: x\ncoverage_min: 80\n"), DEFAULT_MAX_IN_PROGRESS);
  assert.equal(DEFAULT_MAX_IN_PROGRESS, 3);
});

test("downstream layout: this file run beside a config.yml with no dispatch block has 0 failures and skips the template-config test",
  { skip: inCanonical ? false : "canonical-only: it builds the downstream layout itself" }, (t) => {
    const root = mkdtempSync(join(tmpdir(), "flow-dispatch-downstream-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".flow", "tasks"), { recursive: true });
    writeFileSync(join(root, ".flow", "config.yml"), "project:\n  name: downstream\ncoverage_min: 80\n");
    cpSync(BIN, join(root, ".flow", "bin"), { recursive: true });
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    delete env.NODE_TEST_CONTEXT; // otherwise the child believes it is nested and refuses to run
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, ".flow", "bin", "flow-dispatch.test.mjs")],
      { cwd: root, encoding: "utf8", env });
    const out = r.stdout + r.stderr;
    assert.match(out, /^# fail 0$/m, out);
    assert.equal(r.status, 0, out);
    assert.match(out, /^# skipped 2$/m, "the template-config test and this test are the two skips downstream");
    assert.match(out, /^\s*ok \d+ - the template's config declares the dispatch cap at the default # SKIP /m, out);
  });

test("routineFor / routineEnvNames / planDispatch / decisionLine", () => {
  assert.deepEqual(routineEnvNames("fable"), { id: "FLOW_ROUTINE_FABLE_ID", token: "FLOW_ROUTINE_FABLE_TOKEN" });
  assert.equal(routineFor("haiku", {}), null);
  assert.deepEqual(routineFor("haiku", { FLOW_ROUTINE_HAIKU_ID: " h ", FLOW_ROUTINE_HAIKU_TOKEN: "t" }), { id: "h", token: "t" });
  assert.deepEqual(planDispatch([], 3), { decision: "skipped", reason: "nothing-ready" });
  assert.deepEqual(planDispatch([{ id: "A", status: "ready", priority: 1, touches: [] }], 3), { decision: "pick", taskId: "A" });
  assert.equal(decisionLine("skipped", { reason: "x", task: "", n: undefined }), "flow-dispatch: decision=skipped reason=x");
});

test("readLatestFromMain reads the task as origin/main holds it now, not the checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "flow-dispatch-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  for (const dir of [work, other]) git(root, "clone", "-q", origin, dir);
  for (const dir of [work, other]) {
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "checkout", "-q", "-B", "main");
  }
  mkdirSync(join(work, ".flow", "tasks"), { recursive: true });
  const file = join(work, ".flow", "tasks", "p-1.md");
  writeFileSync(file, task("P-1"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "ready");
  git(work, "push", "-q", "origin", "main");

  // Someone else claims it; the checkout in `work` still says ready.
  git(other, "pull", "-q", "origin", "main");
  writeFileSync(join(other, ".flow", "tasks", "p-1.md"), task("P-1", { status: "in_progress" }));
  git(other, "commit", "-q", "-am", "claim");
  git(other, "push", "-q", "origin", "main");

  assert.match(readFileSync(file, "utf8"), /status: "ready"/);
  assert.match(readLatestFromMain(file, { cwd: work }), /status: "in_progress"/);
  assert.throws(() => readLatestFromMain(file, { cwd: root }), "outside a repo, the re-read fails closed");
});

test("the CLI refuses arguments", async () => {
  const err = [];
  assert.equal(await runDispatchCli(["--x"], { flowDir: BIN, error: (s) => err.push(s) }), 2);
  assert.match(err.join(""), /usage/);
});
