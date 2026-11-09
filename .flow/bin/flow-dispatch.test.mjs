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
  // Always an explicit store (flow-0198): without FLOW_DISPATCH_FLOW_DIR the CLI reads the tasks
  // of whatever repo this suite runs in, and one malformed task there turns this test red.
  const r = spawnSync(process.execPath, [join(BIN, "flow-dispatch.mjs")],
    { encoding: "utf8", env: { PATH: process.env.PATH, FLOW_DISPATCH_FLOW_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "flow-dispatch: decision=skipped reason=no-routine-for-sonnet task=P-1",
    "the CLI read the fixture store, not the repo it ran in");

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

test("the CLI ignores a bad task in the surrounding repo's own store when given a fixture store", (t) => {
  // A throwaway adopting repo: this bin copied into `.flow/bin/`, and in its own `.flow/tasks/` the
  // task that broke inflight#95 — model set, model_reason empty — which fails the run if it is read.
  const root = mkdtempSync(join(tmpdir(), "flow-dispatch-badstore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".flow", "tasks"), { recursive: true });
  cpSync(BIN, join(root, ".flow", "bin"), { recursive: true });
  writeFileSync(join(root, ".flow", "tasks", "bad-1.md"),
    task("BAD-1", { model: "sonnet" }).replace('model_reason: "because"', 'model_reason: ""'));
  const { dir } = store(t, { "p-1.md": task("P-1") });
  const cli = join(root, ".flow", "bin", "flow-dispatch.mjs");
  const run = (extra) => spawnSync(process.execPath, [cli],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, ...extra } });

  const isolated = run({ FLOW_DISPATCH_FLOW_DIR: dir });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(isolated.stdout.trim(), "flow-dispatch: decision=skipped reason=no-routine-for-sonnet task=P-1");

  const outcome = run({}); // no override: the default is still the repo's own `.flow/`
  assert.match(outcome.stdout + outcome.stderr, /BAD-1/, "the default store is unchanged: it reads the repo's own tasks");
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

// ── flow-0211: a tier with ready work and no routine gets one issue, not silence ─────────────
//
// A fake GitHub behind the same `fetchImpl` the fire call uses. It routes on URL, keeps issues in
// memory, and records every request, so "no second issue" and "no token in any request" are
// asserted from what reached the API.
const GH_TOKEN = "ghs_job_token_0211";
const GH_REPO = "acme/widgets";

function fakeGitHub({ fail = false, issues = [] } = {}) {
  const state = { issues: issues.map((i) => ({ ...i })), next: 100, requests: [], fires: [] };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.startsWith("https://api.anthropic.com/")) {
      state.fires.push({ url, body });
      return json(200, { claude_code_session_id: "s1" });
    }
    state.requests.push({ url, method: init.method, headers: init.headers, body });
    if (fail) return json(403, { message: "Resource not accessible by integration" });
    const path = url.replace(`https://api.github.com/repos/${GH_REPO}`, "");
    if (init.method === "GET" && path.startsWith("/issues?state=open&labels=flow-dispatch")) {
      return json(200, state.issues.filter((i) => i.state === "open" && i.labels.includes("flow-dispatch")));
    }
    if (init.method === "GET" && path.startsWith("/issues?state=open&sort=created")) {
      return json(200, state.issues.filter((i) => i.state === "open").reverse());
    }
    if (init.method === "POST" && path === "/issues") {
      const issue = { number: state.next++, state: "open", title: body.title, body: body.body,
        labels: body.labels, html_url: `https://github.com/${GH_REPO}/issues/${state.next - 1}`, comments: [] };
      state.issues.push(issue);
      return json(201, issue);
    }
    const m = path.match(/^\/issues\/(\d+)(\/comments)?$/);
    const issue = m && state.issues.find((i) => i.number === Number(m[1]));
    if (issue && m[2] && init.method === "POST") { issue.comments.push(body.body); return json(201, {}); }
    if (issue && init.method === "PATCH") { Object.assign(issue, body); return json(200, issue); }
    return json(404, { message: "Not Found" });
  };
  return { state, fetchImpl };
}

async function runWithGitHub(tasksDir, gh, { tiers = {}, extraEnv = {}, summaryFile } = {}) {
  const out = []; const err = [];
  const code = await dispatch({
    tasksDir,
    env: { ...env(tiers), GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: GH_REPO,
      ...(summaryFile ? { GITHUB_STEP_SUMMARY: summaryFile } : {}), ...extraEnv },
    fetchImpl: gh.fetchImpl,
    readLatest: (file) => readFileSync(file, "utf8"),
    log: (s) => out.push(s), error: (s) => err.push(s),
  });
  return { code, out, err };
}
const openIssues = (gh) => gh.state.issues.filter((i) => i.state === "open");

test("flow-0211: a ready sonnet task with no sonnet routine exits 0 and opens exactly one labelled issue naming the tier, the task and both setting names", async (t) => {
  const { dir, tasksDir } = store(t, { "p-1.md": task("P-1") });
  const gh = fakeGitHub();
  const summaryFile = join(dir, "summary.md");
  const r = await runWithGitHub(tasksDir, gh, { summaryFile });

  assert.equal(r.code, 0);
  assert.deepEqual(r.out, ["flow-dispatch: decision=skipped reason=no-routine-for-sonnet task=P-1"]);
  assert.equal(gh.state.fires.length, 0, "nothing is fired");
  const open = openIssues(gh);
  assert.equal(open.length, 1);
  const [issue] = open;
  assert.deepEqual(issue.labels, ["flow-dispatch"]);
  assert.equal(issue.title, "Flow cannot start sonnet tasks: no routine is configured for the sonnet tier");
  assert.match(issue.body, /`P-1`/);
  assert.match(issue.body, /1 ready task uses the \*\*sonnet\*\* model tier/);
  assert.match(issue.body, /`FLOW_ROUTINE_SONNET_ID`/);
  assert.match(issue.body, /`FLOW_ROUTINE_SONNET_TOKEN`/);
  assert.match(issue.body, /docs\/flow-routines\.md/);
  // The request authenticates with the job's own token, as the GitHub API expects.
  assert.equal(gh.state.requests[0].headers.Authorization, `Bearer ${GH_TOKEN}`);
  assert.match(gh.state.requests[0].url, /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/issues\?state=open&labels=flow-dispatch/);
  // The run page says so too.
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /decision=skipped reason=no-routine-for-sonnet/);
  assert.match(summary, /Issue opened: https:\/\/github\.com\/acme\/widgets\/issues\/100/);
});

test("flow-0211: with the issue already open, a second run with two ready sonnet tasks opens no second issue and lists both ids", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const gh = fakeGitHub();
  await runWithGitHub(tasksDir, gh);
  writeFileSync(join(tasksDir, "p-2.md"), task("P-2", { priority: 2 }));
  // An opus task is not counted on the sonnet issue.
  writeFileSync(join(tasksDir, "p-3.md"), task("P-3", { priority: 3, model: "opus", effort: "high" }));
  const r = await runWithGitHub(tasksDir, gh, { tiers: { opus: "trig_opus" } });

  assert.equal(r.code, 0);
  const open = openIssues(gh);
  assert.equal(open.length, 1, "one issue per tier, never one per run");
  assert.match(open[0].body, /2 ready tasks use the \*\*sonnet\*\* model tier/);
  assert.match(open[0].body, /`P-1`, `P-2`/);
  assert.doesNotMatch(open[0].body, /P-3/);
  assert.equal(gh.state.requests.filter((q) => q.method === "POST").length, 1, "created once");
  assert.equal(gh.state.requests.filter((q) => q.method === "PATCH").length, 1, "then updated in place");

  // A third run with nothing new leaves the issue alone.
  const before = gh.state.requests.length;
  await runWithGitHub(tasksDir, gh, { tiers: { opus: "trig_opus" } });
  assert.deepEqual(gh.state.requests.slice(before).map((q) => q.method), ["GET"], "unchanged: read, no write");
});

test("flow-0211: an open sonnet issue is closed with a comment when a run fires the sonnet routine", async (t) => {
  const { dir, tasksDir } = store(t, { "p-1.md": task("P-1") });
  const gh = fakeGitHub({ issues: [
    { number: 7, state: "open", title: "x", body: "<!-- flow-dispatch:no-routine:opus -->", labels: ["flow-dispatch"], comments: [] },
    { number: 9, state: "open", title: "pr", body: "<!-- flow-dispatch:no-routine:sonnet -->", labels: ["flow-dispatch"], comments: [], pull_request: {} },
  ] });
  await runWithGitHub(tasksDir, gh);
  const sonnet = openIssues(gh).find((i) => i.body.includes("no-routine:sonnet") && !i.pull_request);
  assert.ok(sonnet);

  const summaryFile = join(dir, "summary.md");
  const r = await runWithGitHub(tasksDir, gh, { tiers: { sonnet: "trig_sonnet" }, summaryFile });
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, ["flow-dispatch: decision=fired task=P-1 tier=sonnet"]);
  assert.equal(gh.state.fires.length, 1);
  assert.equal(sonnet.state, "closed");
  assert.equal(sonnet.state_reason, "completed");
  assert.equal(sonnet.comments.length, 1);
  assert.match(sonnet.comments[0], /^Flow started `P-1` on the sonnet routine/);
  assert.equal(gh.state.issues.find((i) => i.number === 7).state, "open", "another tier's issue is left alone");
  assert.equal(gh.state.issues.find((i) => i.number === 9).state, "open", "a pull request is never touched");
  assert.match(readFileSync(summaryFile, "utf8"), /Closed the sonnet no-routine issue/);

  // Firing with no issue open makes no write at all: two reads, nothing else.
  const before = gh.state.requests.length;
  writeFileSync(join(tasksDir, "p-1.md"), task("P-1", { status: "in_progress" }));
  writeFileSync(join(tasksDir, "p-2.md"), task("P-2"));
  await runWithGitHub(tasksDir, gh, { tiers: { sonnet: "trig_sonnet" } });
  assert.deepEqual(gh.state.requests.slice(before).map((q) => q.method), ["GET", "GET"]);
});

test("flow-0211: at-capacity, nothing-ready and no-longer-ready skips open or change no issue", async (t) => {
  const cap = store(t, { "a.md": task("A-1", { status: "in_progress" }), "b.md": task("B-1") });
  const none = store(t, { "a.md": task("A-1", { status: "done" }) });
  const gone = store(t, { "a.md": task("A-1") });
  for (const [tasksDir, reason, opts] of [
    [cap.tasksDir, "at-capacity", { configText: "dispatch:\n  max_in_progress: 1\n" }],
    [none.tasksDir, "nothing-ready", {}],
    [gone.tasksDir, "no-longer-ready", { readLatest: () => task("A-1", { status: "in_progress" }) }],
  ]) {
    const gh = fakeGitHub();
    const out = [];
    const code = await dispatch({
      tasksDir, env: { ...env({ sonnet: "trig_sonnet" }), GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: GH_REPO },
      fetchImpl: gh.fetchImpl, readLatest: opts.readLatest ?? ((f) => readFileSync(f, "utf8")),
      configText: opts.configText ?? "", log: (s) => out.push(s), error: () => {},
    });
    assert.equal(code, 0);
    assert.match(out[0], new RegExp(`reason=${reason}`));
    assert.deepEqual(gh.state.requests, [], `${reason}: no GitHub call at all`);
  }
});

test("flow-0211: no request ever carries a routine token or id value, only setting names", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1"), "p-2.md": task("P-2", { model: "opus", effort: "high" }) });
  const gh = fakeGitHub();
  // Opus is configured with a recognisable token and id; sonnet is not configured at all.
  await runWithGitHub(tasksDir, gh, { tiers: { opus: "trig_opus_ID_VALUE" } });
  writeFileSync(join(tasksDir, "p-1.md"), task("P-1", { status: "in_progress" }));
  await runWithGitHub(tasksDir, gh, { tiers: { opus: "trig_opus_ID_VALUE" }, extraEnv: { FLOW_ROUTINE_SONNET_ID: "half_set_ID_VALUE" } });
  const sent = JSON.stringify(gh.state.requests.map(({ url, body }) => ({ url, body })));
  assert.ok(gh.state.requests.length > 0);
  assert.ok(!sent.includes(TOKEN), "no routine token in any GitHub request");
  assert.ok(!sent.includes("ID_VALUE"), "no routine id value in any GitHub request");
  for (const q of gh.state.requests) assert.equal(q.headers.Authorization, `Bearer ${GH_TOKEN}`);
});

test("flow-0211: when the GitHub issue calls fail, the skip still exits 0 and the summary says the issue could not be written", async (t) => {
  const { dir, tasksDir } = store(t, { "p-1.md": task("P-1") });
  const gh = fakeGitHub({ fail: true });
  const summaryFile = join(dir, "summary.md");
  const r = await runWithGitHub(tasksDir, gh, { summaryFile });
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, ["flow-dispatch: decision=skipped reason=no-routine-for-sonnet task=P-1"]);
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /The sonnet tier has no routine\. The issue could not be written: GitHub answered HTTP 403 to GET \/issues/);
  assert.match(r.err.join("\n"), /::warning::flow-dispatch: the no-routine issue for the sonnet tier could not be written/);
  assert.ok(!summary.includes(GH_TOKEN) && !r.err.join("").includes(GH_TOKEN));

  // A fired run whose close call fails is still fired, still 0.
  const fired = await runWithGitHub(tasksDir, gh, { tiers: { sonnet: "trig_sonnet" }, summaryFile });
  assert.equal(fired.code, 0);
  assert.deepEqual(fired.out, ["flow-dispatch: decision=fired task=P-1 tier=sonnet"]);
  assert.match(readFileSync(summaryFile, "utf8"), /could not be checked or closed: GitHub answered HTTP 403/);

  // A fetch that throws (network down) is the same: green, and said.
  const thrown = await dispatch({
    tasksDir, env: { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: GH_REPO, GITHUB_STEP_SUMMARY: summaryFile },
    fetchImpl: async () => { throw new Error(`socket hang up ${GH_TOKEN}`); },
    readLatest: (f) => readFileSync(f, "utf8"), log: () => {}, error: () => {},
  });
  assert.equal(thrown.valueOf(), 0);
  assert.match(readFileSync(summaryFile, "utf8"), /could not be written: socket hang up \*\*\*/);
});

test("flow-0211: with no GITHUB_TOKEN or repository, no issue call is made and the summary says why", async (t) => {
  const { dir, tasksDir } = store(t, { "p-1.md": task("P-1") });
  const summaryFile = join(dir, "summary.md");
  for (const extra of [{ GITHUB_REPOSITORY: GH_REPO }, { GITHUB_TOKEN: GH_TOKEN }, { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: "not a repo" }]) {
    const calls = [];
    const code = await dispatch({
      tasksDir, env: { ...extra, GITHUB_STEP_SUMMARY: summaryFile },
      fetchImpl: async (url) => { calls.push(url); throw new Error("no call expected"); },
      readLatest: (f) => readFileSync(f, "utf8"), log: () => {}, error: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
  }
  assert.match(readFileSync(summaryFile, "utf8"), /No issue was written: this run has no GITHUB_TOKEN or GITHUB_REPOSITORY/);
});

test("flow-0211: GITHUB_API_URL is honoured, for GitHub Enterprise", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  const urls = [];
  await dispatch({
    tasksDir, env: { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: GH_REPO, GITHUB_API_URL: "https://ghe.example.com/api/v3/" },
    fetchImpl: async (url, init) => { urls.push(`${init.method} ${url}`); return { ok: true, status: 200, json: async () => (init.method === "GET" ? [] : { number: 1 }) }; },
    readLatest: (f) => readFileSync(f, "utf8"), log: () => {}, error: () => {},
  });
  assert.deepEqual(urls, [
    `GET https://ghe.example.com/api/v3/repos/${GH_REPO}/issues?state=open&labels=flow-dispatch&per_page=100`,
    `GET https://ghe.example.com/api/v3/repos/${GH_REPO}/issues?state=open&sort=created&direction=desc&per_page=100`,
    `POST https://ghe.example.com/api/v3/repos/${GH_REPO}/issues`,
  ]);
});

test("flow-0211: an issue whose label was dropped is still found by its marker, so no second issue is opened", async (t) => {
  const { tasksDir } = store(t, { "p-1.md": task("P-1") });
  // GitHub drops labels a token may not set: the issue exists, unlabelled.
  const gh = fakeGitHub({ issues: [
    { number: 5, state: "open", title: "old", body: "<!-- flow-dispatch:no-routine:sonnet -->\nold", labels: [], comments: [] },
  ] });
  await runWithGitHub(tasksDir, gh);
  assert.equal(gh.state.issues.length, 1, "found by marker, not re-opened");
  assert.match(gh.state.issues[0].body, /`P-1`/, "and updated in place");
  assert.deepEqual(gh.state.requests.map((q) => q.method), ["GET", "GET", "PATCH"]);

  // Firing then closes it the same way.
  await runWithGitHub(tasksDir, gh, { tiers: { sonnet: "trig_sonnet" } });
  assert.equal(gh.state.issues[0].state, "closed");
});
