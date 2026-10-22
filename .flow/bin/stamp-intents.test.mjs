// stamp-intents.test.mjs — proving tests for flow-0127 (ADR-0007 slice 4): an intent's
// `approved_by` / `approved_at` are written from the merge that approved it, never by hand.
//
// Zero dependencies for the helper's own tests. The canonical-only section at the foot reads
// `_flow-done.yml` with `yaml` (the way GitHub does) and skips visibly without it, exactly as
// flow-recover.test.mjs does — the tooling gate job runs these with no install step.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  intentStatus, isIntentPath, parseArgs, runStampCli, stampIntents, stampText, validateMerge,
} from "./stamp-intents.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const HELPER = join(BIN, "stamp-intents.mjs");

const BY = "CandidDan";
const AT = "2026-10-03T07:52:11Z";

// An intent in the template's shape: comments after the two stamped values, a body below.
const intent = ({ status = "approved", by = '""', at = '""', eol = "\n" } = {}) => [
  "---",
  'id: "a"',
  'title: "Something the human wants"',
  `status: "${status}"         # proposed | approved | superseded`,
  'created: "2026-10-01"',
  `approved_by: ${by}           # WRITTEN BY CI, NOT BY HAND.`,
  `approved_at: ${at}           # approval EVENT`,
  "evidence: []",
  "---",
  "",
  "## Problem",
  "",
  "approved_by: \"not frontmatter\" — body text is never touched",
  "",
].join(eol);

const run = (files, base = {}) => stampIntents({
  changed: Object.keys(files),
  read: (p) => files[p] ?? null,
  readBase: (p) => base[p] ?? null,
  mergedBy: BY,
  mergedAt: AT,
});

// Every line but the two stamped ones must be byte-identical.
function assertOnlyStampedLinesDiffer(before, after, eol = "\n") {
  const a = before.split(eol);
  const b = after.split(eol);
  assert.equal(a.length, b.length, "no line added or removed");
  for (let i = 0; i < a.length; i++) {
    if (/^approved_(by|at):/.test(a[i])) continue;
    assert.equal(b[i], a[i], `line ${i + 1} changed`);
  }
}

// ── criterion 1: proposed -> approved, empty fields, stamped and nothing else moved ─────────

test("criterion 1: an intent this merge approved is stamped with the merger and the full UTC instant", () => {
  const before = intent();
  const out = run({ ".flow/intents/a.md": before }, { ".flow/intents/a.md": intent({ status: "proposed" }) });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, ".flow/intents/a.md");
  assert.match(out[0].text, /^approved_by: "CandidDan" {11}# WRITTEN BY CI, NOT BY HAND\.$/m);
  assert.match(out[0].text, /^approved_at: "2026-10-03T07:52:11Z" {11}# approval EVENT$/m);
  assertOnlyStampedLinesDiffer(before, out[0].text);
  assert.match(out[0].text, /^approved_by: "not frontmatter"/m, "the body's look-alike line is untouched");
});

test("criterion 1: a brand-new intent merged straight in as approved is stamped too (no base copy)", () => {
  const out = run({ ".flow/intents/a.md": intent() });
  assert.equal(out.length, 1, "no base text means it was not approved before this merge");
});

// ── criterion 2: a hand-typed value never survives ──────────────────────────────────────────

test("criterion 2: hand-typed approved_by / approved_at are overwritten with the merge's values", () => {
  const before = intent({ by: '"someone"', at: '"2026-10-03"' });
  const [r] = run({ ".flow/intents/a.md": before }, { ".flow/intents/a.md": intent({ status: "proposed" }) });
  assert.match(r.text, /^approved_by: "CandidDan" /m);
  assert.match(r.text, /^approved_at: "2026-10-03T07:52:11Z" /m);
  assert.doesNotMatch(r.text, /someone/);
  assertOnlyStampedLinesDiffer(before, r.text);
});

// ── criterion 3: what is never stamped ──────────────────────────────────────────────────────

test("criterion 3: already-approved, proposed, superseded, _TEMPLATE.md and non-intent files are all left alone", () => {
  const files = {
    ".flow/intents/old.md": intent({ by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' }) + "edited body\n",
    ".flow/intents/proposed.md": intent({ status: "proposed" }),
    ".flow/intents/superseded.md": intent({ status: "superseded" }),
    ".flow/intents/_TEMPLATE.md": intent(),
    "docs/intent-like.md": intent(),
    ".flow/intents/nested/deeper.md": intent(),
    ".flow/tasks/flow-0001-x.md": intent(),
  };
  const base = { ".flow/intents/old.md": intent({ by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' }) };
  assert.deepEqual(run(files, base), [],
    "the approval belongs to the merge that MADE it approved; nothing else is an approval");
});

test("criterion 3: isIntentPath is exactly the direct, non-template .md children of .flow/intents/", () => {
  assert.equal(isIntentPath(".flow/intents/a.md"), true);
  for (const p of [".flow/intents/_TEMPLATE.md", ".flow/intents/a.txt", ".flow/intents/x/a.md",
    "project-template/.flow/intents/a.md", ".flow/intentsa.md", null]) {
    assert.equal(isIntentPath(p), false, String(p));
  }
});

test("criterion 3: a deleted intent, or one with no frontmatter, is not stamped", () => {
  assert.deepEqual(stampIntents({ changed: [".flow/intents/gone.md"], read: () => null, mergedBy: BY, mergedAt: AT }), []);
  assert.deepEqual(run({ ".flow/intents/a.md": "status: approved\n" }), []);
  assert.equal(intentStatus("---\nid: x\n"), null, "an unclosed frontmatter has no status");
  assert.equal(intentStatus(null), null);
});

test("a re-run over an already-stamped tip changes nothing, so the push retry can tell it already landed", () => {
  const stamped = intent({ by: `"${BY}"`, at: `"${AT}"` });
  assert.deepEqual(run({ ".flow/intents/a.md": stamped }), []);
});

// ── criterion 4: CRLF and single quotes survive ─────────────────────────────────────────────

test("criterion 4: CRLF line endings and single-quoted values are kept; only the two values change", () => {
  const before = intent({ by: "''", at: "'2026-10-03'", eol: "\r\n" });
  const [r] = run({ ".flow/intents/a.md": before });
  assert.match(r.text, /\r\napproved_by: 'CandidDan' {11}# WRITTEN BY CI, NOT BY HAND\.\r\n/);
  assert.match(r.text, /\r\napproved_at: '2026-10-03T07:52:11Z' {11}# approval EVENT\r\n/);
  assert.equal(r.text.split("\r\n").length, before.split("\r\n").length);
  assert.doesNotMatch(r.text.replace(/\r\n/g, ""), /\n/, "no bare LF was introduced");
  assertOnlyStampedLinesDiffer(before, r.text, "\r\n");
});

test("stampText: a bare or empty value is written double-quoted; a missing field is added before the closing ---", () => {
  assert.equal(stampText("---\nstatus: approved\napproved_by:\napproved_at: 2026-10-03\n---\n", BY, AT),
    `---\nstatus: approved\napproved_by: "${BY}"\napproved_at: "${AT}"\n---\n`);
  assert.equal(stampText("---\r\nstatus: approved\r\n---\r\nbody\r\n", BY, AT),
    `---\r\nstatus: approved\r\napproved_by: "${BY}"\r\napproved_at: "${AT}"\r\n---\r\nbody\r\n`);
  assert.throws(() => stampText("no frontmatter\n", BY, AT), /no frontmatter/);
});

test("intentStatus reads quoted, single-quoted and bare status values", () => {
  assert.equal(intentStatus('---\nstatus: "approved"  # c\n---\n'), "approved");
  assert.equal(intentStatus("---\nstatus: 'approved'\n---\n"), "approved");
  assert.equal(intentStatus("---\nstatus: approved # c\n---\n"), "approved");
});

// ── criterion 5: a bad merge refuses rather than stamping something untrue ──────────────────

test("criterion 5: a mergedAt that is not a full UTC instant, or an empty mergedBy, throws", () => {
  const call = (mergedBy, mergedAt) => () =>
    stampIntents({ changed: [".flow/intents/a.md"], read: () => intent(), mergedBy, mergedAt });
  for (const at of ["2026-10-03", "2026-10-03T07:52:11", "2026-10-03T07:52:11+01:00",
    "2026-10-03 07:52:11Z", "2026-02-30T07:52:11Z", "", undefined]) {
    assert.throws(call(BY, at), /not a full UTC ISO-8601 instant/, String(at));
  }
  assert.throws(call("", AT), /mergedBy is empty/);
  assert.throws(call(undefined, AT), /mergedBy is empty/);
  assert.throws(call('evil"\nstatus: x', AT), /not a GitHub login/, "nothing that could break the YAML reaches it");
  assert.doesNotThrow(() => validateMerge("github-actions[bot]", AT), "an app merge is still a login");
});

test("criterion 5: the CLI exits non-zero, naming the problem, on a bad merge value or bad flags", () => {
  const cli = (args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: "utf8" });
  const bad = cli(["--base", "abc", "--head", "def", "--merged-by", BY, "--merged-at", "2026-10-03"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a full UTC ISO-8601 instant/);
  const empty = cli(["--base", "abc", "--head", "def", "--merged-by", "", "--merged-at", AT]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /mergedBy is empty/);

  assert.throws(() => parseArgs(["--nope", "x"]), /unknown argument/);
  assert.throws(() => parseArgs(["--base"]), /needs a value/);
  assert.throws(() => parseArgs(["--base", "-x", "--head", "y"]), /--base <sha> is required/);
  assert.throws(() => parseArgs(["--head", "x"]), /--base <sha> is required/);
});

// ── criterion 6: the CLI against a real repo ────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "commit.gpgsign", "false");
}

// A base commit holding a proposed intent, an already-approved one and a doc; then a PR branch
// that approves the first, edits the second's body and the doc; merged with a real merge commit.
function approvalRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stamp-intents-"));
  initRepo(dir);
  mkdirSync(join(dir, ".flow", "intents"), { recursive: true });
  mkdirSync(join(dir, "docs"));
  const old = intent({ by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' });
  writeFileSync(join(dir, ".flow/intents/a.md"), intent({ status: "proposed" }));
  writeFileSync(join(dir, ".flow/intents/old.md"), old);
  writeFileSync(join(dir, "docs/x.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-qb", "pr");
  writeFileSync(join(dir, ".flow/intents/a.md"), intent());
  writeFileSync(join(dir, ".flow/intents/old.md"), old + "an edit after approval\n");
  writeFileSync(join(dir, "docs/x.md"), "y\n");
  git(dir, "commit", "-qam", "approve a");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "pr", "-m", "Merge pull request #37");
  return { dir, base, head: git(dir, "rev-parse", "HEAD"), merge: git(dir, "rev-parse", "HEAD") };
}

test("criterion 6: the CLI rewrites only the intent this merge approved, prints one line naming it, exits 0", () => {
  const { dir, head } = approvalRepo();
  try {
    const firstParent = git(dir, "rev-parse", `${head}^1`);
    const r = spawnSync(process.execPath,
      [HELPER, "--base", firstParent, "--head", head, "--merged-by", BY, "--merged-at", AT],
      { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"),
      [`stamped .flow/intents/a.md: approved_by=${BY} approved_at=${AT}`]);
    assert.equal(git(dir, "status", "--porcelain"), "M .flow/intents/a.md", "that file and no other");
    const text = readFileSync(join(dir, ".flow/intents/a.md"), "utf8");
    assert.match(text, /^approved_by: "CandidDan" /m);
    assert.match(text, /^approved_at: "2026-10-03T07:52:11Z" /m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("criterion 6: with nothing to stamp the CLI exits 0 and writes nothing", () => {
  const { dir, head } = approvalRepo();
  try {
    // Base = head: the diff is empty, so no intent was approved by "this merge".
    const out = [];
    const code = runStampCli(["--base", head, "--head", head, "--merged-by", BY, "--merged-at", AT],
      { cwd: dir, out: { write: (s) => out.push(s) }, err: { write: (s) => out.push(s) } });
    assert.equal(code, 0);
    assert.match(out.join(""), /nothing to stamp/);
    assert.equal(git(dir, "status", "--porcelain"), "", "the working tree is untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("criterion 6: an unknown revision fails the CLI with git's own error rather than stamping nothing quietly", () => {
  const { dir } = approvalRepo();
  try {
    const err = [];
    const code = runStampCli(["--base", "0000000", "--head", "HEAD", "--merged-by", BY, "--merged-at", AT],
      { cwd: dir, out: { write: () => {} }, err: { write: (s) => err.push(s) } });
    assert.equal(code, 1);
    assert.match(err.join(""), /0000000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── canonical-only: the adapter and the workflow (criteria 7 and 8) ─────────────────────────
//
// `.flow/bin/stamp-intents.mjs` (the adapter) and `_flow-done.yml` (the reusable) exist only in
// canonical. An adopting repo has the helper copied into `.flow/bin/` and a thin caller instead,
// so asserting on them there would fail a correct repo.
const CANON = (() => {
  const root = resolve(BIN, "..", "..", "..");
  return existsSync(join(root, ".github", "workflows", "_flow-done.yml")) &&
    existsSync(join(root, "project-template", ".flow", "bin", "stamp-intents.mjs")) ? root : null;
})();
const notCanonical = "canonical-only: the adapter and the reusable _flow-done.yml are authored in " +
  "canonical; an adopting repo has neither, so there is nothing here to assert on.";
const yamlMod = await import("yaml").then((m) => m, () => null);
const needsYaml = "needs `npm ci` (yaml) — runs in the per-stack gate job";

test("criterion 7: .flow/bin/stamp-intents.mjs is an ADAPTER — imports the template, holds no decision logic", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  const adapter = join(CANON, ".flow", "bin", "stamp-intents.mjs");
  const src = readFileSync(adapter, "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(code, /from "\.\.\/\.\.\/project-template\/\.flow\/bin\/stamp-intents\.mjs"/,
    "it must import the template module");
  assert.doesNotMatch(code, /\bfunction\s+(?!__)\w*\s*\(/, "no function of its own: logic lives in the template");
  for (const word of ['"approved"', "intents/", "readFileSync", "writeFileSync", "execFileSync"]) {
    assert.ok(!code.includes(word), `the adapter must not decide or do I/O itself (found ${JSON.stringify(word)})`);
  }
  const mod = await import(adapter);
  const tpl = await import(HELPER);
  assert.equal(mod.stampIntents, tpl.stampIntents, "the same function, re-exported — not a copy");
  assert.equal(mod.runStampCli, tpl.runStampCli);

  // And its CLI block actually runs: silence here is the symlink failure mode.
  const r = spawnSync(process.execPath, [adapter, "--base", "a", "--head", "b", "--merged-by", "", "--merged-at", AT],
    { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mergedBy is empty/);
});

const stampStep = () => {
  const wf = yamlMod.parse(readFileSync(join(CANON, ".github", "workflows", "_flow-done.yml"), "utf8"));
  const steps = wf.jobs["mark-done"].steps;
  const i = steps.findIndex((s) => s.name === "Stamp intents this merge approved");
  assert.notEqual(i, -1, "the stamping step exists in mark-done");
  return { wf, steps, i, step: steps[i] };
};

test("criterion 8: _flow-done.yml's stamping step is gated on the merge and fed from the event", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  if (!yamlMod) return t.skip(needsYaml);
  const { wf, steps, i, step } = stampStep();
  const transition = steps.findIndex((s) => s.name === "Flip the merged task to done");
  assert.ok(transition !== -1 && i > transition, "it runs AFTER the task transition");
  assert.match(step.if, /github\.event\.pull_request\.merged == true/);
  assert.match(step.if, /!cancelled\(\)/, "a failed transition must not drop a stamp");
  assert.equal(step.env.MERGED_BY, "${{ github.event.pull_request.merged_by.login }}");
  assert.equal(step.env.MERGED_AT, "${{ github.event.pull_request.merged_at }}");
  assert.equal(step.env.MERGE_SHA, "${{ github.event.pull_request.merge_commit_sha }}");
  assert.equal(wf.permissions.contents, "write");
  assert.match(step.run, /--merged-by "\$MERGED_BY" --merged-at "\$MERGED_AT"/);
  assert.match(step.run, /BASE_SHA="\$\(git rev-parse "\$MERGE_SHA\^1"\)"/, "base is the merge's first parent");
  assert.doesNotMatch(step.run, /\$\{\{/, "event values reach the shell through env, never interpolated");
});

test("criterion 8: the step skips with one log line when the helper is absent, and reuses the push retry", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  if (!yamlMod) return t.skip(needsYaml);
  const { steps, step } = stampStep();
  assert.match(step.run, /if \[ ! -f \.flow\/bin\/stamp-intents\.mjs \]; then\n\s*echo "[^"\n]+"\n\s*exit 0\n/);
  // The flow-0059 loop's mechanics, line for line: bounded attempts, push to HEAD:main, and on a
  // refusal discard and redo against the new tip — never a bare push, never pull/rebase/force.
  const transition = steps.find((s) => s.name === "Flip the merged task to done").run;
  for (const line of ["MAX_PUSH_ATTEMPTS=5", "until git push origin HEAD:main; do",
    'if [ "$attempt" -gt "$MAX_PUSH_ATTEMPTS" ]; then', 'sleep "$attempt"',
    "git fetch origin main --quiet", "git reset --hard FETCH_HEAD"]) {
    assert.ok(transition.includes(line), `the shared loop still has ${line}`);
    assert.ok(step.run.includes(line), `the stamping step reuses ${line}`);
  }
  assert.doesNotMatch(step.run, /^\s*git push origin main\s*$/m);
  const code = step.run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /git (pull|rebase|merge)\b|--force/);
  assert.match(step.run, /git commit -m "\$COMMIT_MSG"/);
  assert.match(step.run, /COMMIT_MSG="flow: stamp intent approval \(PR #\$PR_NUM merged by \$MERGED_BY\)"/);
});

// The step's run block, executed for real against a sandbox: a bare remote standing in for `main`
// and a runner checkout of it. Proves the skip and the stamp-commit-push path end to end.
function sandbox({ withHelper }) {
  const root = mkdtempSync(join(tmpdir(), "stamp-step-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  mkdirSync(work);
  initRepo(work);
  mkdirSync(join(work, ".flow", "intents"), { recursive: true });
  writeFileSync(join(work, ".flow/intents/a.md"), intent({ status: "proposed" }));
  if (withHelper) {
    mkdirSync(join(work, ".flow", "bin"), { recursive: true });
    copyFileSync(HELPER, join(work, ".flow/bin/stamp-intents.mjs"));
  }
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "checkout", "-qb", "pr");
  writeFileSync(join(work, ".flow/intents/a.md"), intent());
  git(work, "commit", "-qam", "approve");
  git(work, "checkout", "-q", "main");
  git(work, "merge", "-q", "--no-ff", "pr", "-m", "Merge pull request #37");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  const runner = join(root, "runner");
  execFileSync("git", ["clone", "-q", remote, runner]);
  git(runner, "config", "commit.gpgsign", "false");
  return { root, remote, runner, merge: git(work, "rev-parse", "HEAD") };
}

const runStep = (sb, script) => spawnSync("bash", ["-e", "-c", script], {
  cwd: sb.runner, encoding: "utf8",
  env: { ...process.env, PR_NUM: "37", MERGED_BY: BY, MERGED_AT: AT, MERGE_SHA: sb.merge },
});

test("criterion 8: the step, run for real — absent helper skips cleanly; present, it stamps and pushes to main", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  if (!yamlMod) return t.skip(needsYaml);
  const { step } = stampStep();

  const absent = sandbox({ withHelper: false });
  try {
    const before = git(absent.remote, "rev-parse", "main");
    const r = runStep(absent, step.run);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "a single log line");
    assert.match(r.stdout, /skipping intent stamping/);
    assert.equal(git(absent.remote, "rev-parse", "main"), before, "nothing pushed");
  } finally { rmSync(absent.root, { recursive: true, force: true }); }

  const present = sandbox({ withHelper: true });
  try {
    const r = runStep(present, step.run);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(present.remote, "log", "-1", "--format=%s", "main"),
      `flow: stamp intent approval (PR #37 merged by ${BY})`);
    const text = git(present.remote, "show", "main:.flow/intents/a.md");
    assert.match(text, /^approved_by: "CandidDan" /m);
    assert.match(text, /^approved_at: "2026-10-03T07:52:11Z" /m);

    // Run again on the stamped tip: nothing left to stamp, nothing pushed.
    const tip = git(present.remote, "rev-parse", "main");
    const again = runStep(present, step.run);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to stamp/);
    assert.equal(git(present.remote, "rev-parse", "main"), tip);
  } finally { rmSync(present.root, { recursive: true, force: true }); }

  // A throw fails the step instead of dropping the stamp.
  const broken = sandbox({ withHelper: true });
  try {
    const r = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: broken.runner, encoding: "utf8",
      env: { ...process.env, PR_NUM: "37", MERGED_BY: BY, MERGED_AT: "2026-10-03", MERGE_SHA: broken.merge },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a full UTC ISO-8601 instant/);
  } finally { rmSync(broken.root, { recursive: true, force: true }); }
});
