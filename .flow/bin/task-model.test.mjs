// task-model.test.mjs — proving tests for the per-task model resolver and escalation (flow-0083).
//
// Pure-core tests first (resolve, cliArgs, escalate), then the CLI against a throwaway store,
// because the CLI is what the workflows run. The "TIERS is the only table" scan is canonical-only
// and lives in `.flow/bin/model-ids.test.mjs`; the reset-path escalation (flow-0174) is proved in
// `flow-recover.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TIERS, TIER_ORDER, EFFORTS, resolve, cliArgs, summaryLine, escalate,
  readField, writeField, readAsks, writeAsks, scalar, topTierAsk, findTaskFile, runCli,
} from "./task-model.mjs";
import { parseAsks } from "./asks.mjs";
import { asksFindings, parseListField } from "./flow-doctor.mjs";

const task = (fields = {}, extra = "") => [
  "---",
  'id: "PROJ-0001"',
  'title: "a task"',
  `status: "${fields.status ?? "ready"}"`,
  ...["model", "effort", "model_reason"].filter((k) => k in fields).map((k) => `${k}: "${fields[k]}"`),
  'touches: ["src/**"]',
  extra,
  "notes: []",
  "---",
  "",
  "## Context",
  "",
  'model: "fable"   <- body prose, never read as a field',
  "",
].filter((l) => l !== "").join("\n").replace("## Context", "\n## Context\n");

// ── the table ──────────────────────────────────────────────────────────────

test("TIERS maps the four tiers to full model IDs, in escalation order", () => {
  assert.deepEqual(TIERS, {
    haiku: "claude-haiku-4-5-20251001",
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    fable: "claude-fable-5-1",
  });
  assert.deepEqual(TIER_ORDER, ["haiku", "sonnet", "opus", "fable"]);
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "max"]);
  for (const id of Object.values(TIERS)) assert.match(id, /^claude-[a-z]+-\d+(-\d+)*$/, `${id} is not a full id`);
  assert.ok(Object.isFrozen(TIERS));
});

// ── criterion 1: the default ─────────────────────────────────────────────

test("no model/effort -> sonnet / claude-sonnet-5-5 / medium / \"default\"", () => {
  assert.deepEqual(resolve(task()), { tier: "sonnet", id: "claude-sonnet-5-5", effort: "medium", reason: "default" });
  assert.deepEqual(resolve({}), { tier: "sonnet", id: "claude-sonnet-5-5", effort: "medium", reason: "default" });
  // The template's empty-string defaults are "unset", not a value to reject.
  assert.deepEqual(resolve({ model: "", effort: "", model_reason: "" }).tier, "sonnet");
});

test("the body is never read as frontmatter", () => {
  assert.equal(resolve(task()).tier, "sonnet", "a `model:` line in the body must not leak into the resolution");
});

// ── criterion 2: the emitted CLI arguments ──────────────────────────────

test("opus/high with a reason emits --model claude-opus-5-5 --effort high", () => {
  const r = resolve(task({ model: "opus", effort: "high", model_reason: "edits CI workflows" }));
  assert.deepEqual(r, { tier: "opus", id: "claude-opus-5-5", effort: "high", reason: "edits CI workflows" });
  const args = cliArgs(r);
  assert.deepEqual(args, ["--model", "claude-opus-5-5", "--effort", "high"]);
  assert.match(args.join(" "), /--model claude-opus-5-5/);
});

test("fable emits claude-fable-5-1; effort alone keeps the sonnet default model", () => {
  assert.ok(cliArgs(resolve({ model: "fable", model_reason: "messy brief" })).includes("claude-fable-5-1"));
  assert.deepEqual(resolve({ effort: "low", model_reason: "mechanical rename" }),
    { tier: "sonnet", id: "claude-sonnet-5-5", effort: "low", reason: "mechanical rename" });
});

test("the summary line names tier, model ID, effort and reason", () => {
  const line = summaryLine("PROJ-0001", resolve({ model: "opus", effort: "high", model_reason: "auth" }));
  for (const s of ["PROJ-0001", "`opus`", "`claude-opus-5-5`", "`high`", "auth"]) assert.ok(line.includes(s), `missing ${s}`);
});

// ── criterion 3: rejections, never a silent fallback ────────────────────

test("model: gpt-5 fails naming the field and the allowed values", () => {
  assert.throws(() => resolve(task({ model: "gpt-5", model_reason: "x" })),
    (e) => /model: "gpt-5"/.test(e.message) && /haiku, sonnet, opus, fable/.test(e.message));
});

test("effort: extreme fails naming the field and the allowed values", () => {
  assert.throws(() => resolve(task({ effort: "extreme", model_reason: "x" })),
    (e) => /effort: "extreme"/.test(e.message) && /low, medium, high, max/.test(e.message));
});

test("model or effort without model_reason fails naming the missing reason", () => {
  assert.throws(() => resolve(task({ model: "opus" })), /model_reason is missing/);
  assert.throws(() => resolve(task({ effort: "high" })), /model_reason is missing/);
  assert.throws(() => resolve(task({ model: "opus", model_reason: "   " })), /model_reason is missing/);
});

// ── criterion 5: escalate ────────────────────────────────────────────────

test("escalate on a sonnet task -> opus with an \"escalated after\" reason", () => {
  const out = escalate(task({ model: "sonnet", model_reason: "x" }), "run 7 ended without a PR");
  assert.equal(readField(out, "model"), "opus");
  assert.equal(readField(out, "model_reason"), "escalated after run 7 ended without a PR (was sonnet)");
  assert.equal(resolve(out).id, "claude-opus-5-5");
});

test("escalate walks the whole ladder, from an unset model too", () => {
  let t = task();
  const seen = [];
  for (let i = 0; i < 3; i++) { t = escalate(t, `e${i}`); seen.push(readField(t, "model")); }
  assert.deepEqual(seen, ["opus", "fable", "fable"], "sonnet (unset) -> opus -> fable, then it stays");
  assert.equal(readField(escalate(task({ model: "haiku", model_reason: "x" }), "e"), "model"), "sonnet");
  assert.equal(readField(escalate(task({ model: "opus", effort: "high", model_reason: "x" }), "e"), "effort"), "high",
    "escalation moves the model, never the effort");
});

test("escalate on a fable task leaves model alone and adds a valid decision ask (flow-doctor accepts it)", () => {
  const before = task({ model: "fable", model_reason: "hard" });
  const out = escalate(before, "PR #9 closed unmerged");
  assert.equal(readField(out, "model"), "fable");
  assert.equal(readField(out, "model_reason"), "hard");
  const asks = readAsks(out);
  assert.equal(asks.length, 1);
  const { asks: parsed, errors } = parseAsks(asks);
  assert.deepEqual(errors, []);
  assert.equal(parsed[0].kind, "decision");
  assert.match(parsed[0].recommend, /split the task/);
  // flow-doctor's own reader and checker, over the rewritten frontmatter.
  const head = out.slice(0, out.indexOf("\n---", 3));
  const asksList = parseListField(head, "asks");
  assert.deepEqual(asksList, asks);
  assert.deepEqual(asksFindings({ id: "PROJ-0001", asksList }), { problems: [], warnings: [] });
});

test("a fable task that keeps failing carries ONE decision ask, refreshed, and keeps other asks", () => {
  let t = task({ model: "fable", model_reason: "hard" }, 'asks:\n  - "fyi: keep me"');
  t = escalate(t, "run 1 ended without a PR");
  t = escalate(t, "run 2 ended without a PR");
  const asks = readAsks(t);
  assert.equal(asks.length, 2);
  assert.equal(asks[0], "fyi: keep me");
  assert.match(asks[1], /run 2/);
  assert.equal(asks[1], topTierAsk("run 2 ended without a PR"));
});

test("escalate refuses a task resolve rejects, rather than guessing its tier", () => {
  assert.throws(() => escalate(task({ model: "gpt-5", model_reason: "x" }), "e"), /not a tier/);
});

// ── the frontmatter helpers ─────────────────────────────────────────────

test("scalar strips quotes and trailing comments, but not a # inside quotes", () => {
  assert.equal(scalar('"opus"   # why'), "opus");
  assert.equal(scalar("'it''s'"), "it's");
  assert.equal(scalar('"see PR #12"'), "see PR #12");
  assert.equal(scalar('"a \\"q\\""'), 'a "q"');
  assert.equal(scalar("plain # c"), "plain");
  assert.equal(scalar(undefined), "");
});

test("writeField replaces in place, appends when absent, and escapes quotes", () => {
  const t = task();
  const a = writeField(t, "model", "opus");
  assert.equal(readField(a, "model"), "opus");
  assert.ok(a.indexOf("model:") < a.indexOf("\n---", 3), "appended inside the frontmatter");
  const b = writeField(a, "model_reason", 'he said "go"\nnow');
  assert.equal(readField(b, "model_reason"), 'he said "go" now');
  const c = writeField(b, "model", "fable");
  assert.equal(c.slice(0, c.indexOf("\n---", 3)).match(/^model:/gm).length, 1, "one model line in the frontmatter");
  assert.match(c, /body prose/, "the body is left alone");
  assert.throws(() => writeField("no frontmatter", "model", "x"), /no frontmatter/);
  assert.equal(readField("no frontmatter", "model"), "");
});

test("readAsks/writeAsks handle the inline, multi-line and absent forms", () => {
  const inline = task({}, "asks: [\"fyi: a\", 'fyi: b''s']");
  assert.deepEqual(readAsks(inline), ["fyi: a", "fyi: b's"]);
  const rewritten = writeAsks(inline, ["fyi: a", "fyi: c"]);
  assert.deepEqual(readAsks(rewritten), ["fyi: a", "fyi: c"]);
  assert.equal(rewritten.match(/^asks:/gm).length, 1);
  assert.match(rewritten, /^notes: \[\]$/m, "the field after asks survives");
  const absent = task();
  assert.deepEqual(readAsks(absent), []);
  assert.deepEqual(readAsks(writeAsks(absent, ["fyi: x"])), ["fyi: x"]);
  assert.deepEqual(readAsks("nope"), []);
  assert.throws(() => writeAsks("nope", []), /no frontmatter/);
});

// ── the CLI, against a throwaway store ─────────────────────────────────

function store(files) {
  const dir = mkdtempSync(join(tmpdir(), "task-model-"));
  const tasks = join(dir, "tasks");
  mkdirSync(tasks);
  for (const [n, s] of Object.entries(files)) writeFileSync(join(tasks, n), s);
  return { dir, tasks };
}

function cli(argv, tasksDir, env = {}) {
  const out = [], err = [];
  const code = runCli(argv, tasksDir, { log: (s) => out.push(s), error: (s) => err.push(s), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("CLI resolve prints args/tier/model/effort, writes GITHUB_OUTPUT and the step summary", () => {
  const { dir, tasks } = store({
    "_TEMPLATE.md": task({ model: "fable", model_reason: "template must be ignored" }).replace("PROJ-0001", "PROJ-0002"),
    "0002-a.md": task({ model: "opus", effort: "high", model_reason: "risky" }).replace("PROJ-0001", "PROJ-0002"),
  });
  try {
    const outFile = join(dir, "out"), sumFile = join(dir, "sum");
    const r = cli(["resolve", "--task-id", "PROJ-0002"], tasks, { GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^args=--model claude-opus-5-5 --effort high$/m);
    const out = readFileSync(outFile, "utf8");
    assert.match(out, /^args=--model claude-opus-5-5 --effort high$/m);
    assert.match(out, /^tier=opus$/m);
    assert.match(out, /^model=claude-opus-5-5$/m);
    assert.match(out, /^effort=high$/m);
    assert.match(readFileSync(sumFile, "utf8"), /reason: risky/);
    assert.equal(findTaskFile(tasks, "PROJ-0002"), join(tasks, "0002-a.md"));
    assert.equal(findTaskFile(join(dir, "missing"), "PROJ-0002"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI resolve fails the run on an invalid value, naming the field", () => {
  const { dir, tasks } = store({ "0001.md": task({ model: "gpt-5", model_reason: "x" }) });
  try {
    const r = cli(["resolve", "--task-id", "PROJ-0001"], tasks);
    assert.equal(r.code, 1);
    assert.match(r.err, /::error::.*model: "gpt-5".*haiku, sonnet, opus, fable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI escalate rewrites the task file one tier up", () => {
  const { dir, tasks } = store({ "0001.md": task({ status: "in_progress" }) });
  try {
    const e = cli(["escalate", "--task-id", "PROJ-0001", "--event", "run 5 ended without a PR"], tasks);
    assert.equal(e.code, 0, e.err);
    assert.match(e.out, /sonnet -> opus/);
    const after = readFileSync(join(tasks, "0001.md"), "utf8");
    assert.equal(readField(after, "model"), "opus");
    assert.match(readField(after, "model_reason"), /escalated after run 5 ended without a PR \(was sonnet\)/);
    cli(["escalate", "--task-id", "PROJ-0001", "--event", "e2"], tasks);
    const top = cli(["escalate", "--task-id", "PROJ-0001", "--event", "e3"], tasks);
    assert.match(top.out, /top tier/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: usage, unknown task and missing --event", () => {
  const { dir, tasks } = store({ "0001.md": task() });
  try {
    assert.equal(cli([], tasks).code, 2);
    assert.equal(cli(["resolve", "--task-id", "NOPE-1"], tasks).code, 1);
    assert.equal(cli(["escalate", "--task-id", "PROJ-0001"], tasks).code, 2);
    assert.equal(cli(["decide", "--task-id", "PROJ-0001"], tasks).code, 2, "decide retired with queue-runner (flow-0174)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── criterion 11: the rubric is stated where the orchestrator and the worker read ──
// Concept-level and whitespace-normalised, like serves-template.test.mjs: an honest rewrite
// survives, a deleted rule does not. Paths are relative to the repo root this bin/ sits in —
// `project-template/` in canonical, the adopting repo's root downstream.

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS = {
  "PROTOCOL.md": join(ROOT, ".flow", "PROTOCOL.md"),
  "task-writer SKILL.md": join(ROOT, ".claude", "skills", "task-writer", "SKILL.md"),
};

for (const [name, path] of Object.entries(DOCS)) {
  test(`${name} carries the four-tier rubric, the default, self-escalation and "never Fable for security review"`, () => {
    const flat = readFileSync(path, "utf8").replace(/\s+/g, " ");
    for (const row of ["`fable` / `high`–`max`", "`opus` / `high`", "`sonnet` / `medium` (default)", "`haiku` / `low`"]) {
      assert.ok(flat.includes(row), `${name}: the rubric row ${row} is missing`);
    }
    assert.match(flat, /default[^.]*`sonnet` \/ `medium`/i, `${name}: the sonnet/medium default is not stated`);
    assert.match(flat, /Never Fable for security-review-style work/, `${name}: the Fable exclusion is missing`);
    assert.match(flat, /`blocked` with a `decision` ask carrying `Recommend: re-run on <tier>`/,
      `${name}: the worker's self-escalation rule is missing`);
    assert.match(flat, /model_reason/, `${name}: departures must be told to carry model_reason`);
  });
}
