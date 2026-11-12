// stamp-intents.test.mjs — proving tests for flow-0127 and flow-0209 (ADR-0007 slice 4): an
// intent's approval — `status: "approved"`, `approved_by`, `approved_at` — is written from the
// merge of the PR that added it, never by hand.
//
// Zero dependencies. The canonical-only tests of the adapter and of `_flow-done.yml` live in
// `.flow/bin/stamp-intents-workflow.test.mjs`: an adopting repo has neither file to assert on.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  addingMergeFromGitHub, approveText, intentApprovedBy, intentStatus, isIntentPath, parseArgs, repairIntents,
  runStampCli, stampIntents, stampText, validateMerge,
} from "./stamp-intents.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const HELPER = join(BIN, "stamp-intents.mjs");

const BY = "CandidDan";
const AT = "2026-10-03T07:52:11Z";

// An intent in the template's shape: comments after the two stamped values, a body below.
const intent = ({ status = "proposed", by = '""', at = '""', eol = "\n" } = {}) => [
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

// Every line but the stamped ones (the two approval fields and `status`) must be byte-identical.
function assertOnlyStampedLinesDiffer(before, after, eol = "\n") {
  const a = before.split(eol);
  const b = after.split(eol);
  assert.equal(a.length, b.length, "no line added or removed");
  for (let i = 0; i < a.length; i++) {
    if (/^(approved_(by|at)|status):/.test(a[i])) continue;
    assert.equal(b[i], a[i], `line ${i + 1} changed`);
  }
}


// ── flow-0209 criterion 1: the merge that ADDS an intent approves it ────────────────────────

test("flow-0209 criterion 1: an added proposed intent with empty fields is stamped approved, with the merger and the merge instant", () => {
  const before = intent();
  const out = run({ ".flow/intents/a.md": before });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, ".flow/intents/a.md");
  assert.match(out[0].text, /^status: "approved" {9}# proposed \| approved \| superseded$/m);
  assert.match(out[0].text, /^approved_by: "CandidDan" {11}# WRITTEN BY CI, NOT BY HAND\.$/m);
  assert.match(out[0].text, /^approved_at: "2026-10-03T07:52:11Z" {11}# approval EVENT$/m);
  assertOnlyStampedLinesDiffer(before, out[0].text);
  assert.match(out[0].text, /^approved_by: "not frontmatter"/m, "the body's look-alike line is untouched");
});

// ── flow-0209 criterion 2: a hand-typed value never survives ────────────────────────────────

test("flow-0209 criterion 2: an added intent with approved_by typed in is overwritten with the merging login", () => {
  const before = intent({ by: '"someone-else"', at: '"2026-10-03"' });
  const [r] = run({ ".flow/intents/a.md": before });
  assert.match(r.text, /^approved_by: "CandidDan" /m);
  assert.match(r.text, /^approved_at: "2026-10-03T07:52:11Z" /m);
  assert.match(r.text, /^status: "approved" /m);
  assert.doesNotMatch(r.text, /someone-else/);
  assertOnlyStampedLinesDiffer(before, r.text);
});

// ── flow-0209 criterion 3: never re-stamped ─────────────────────────────────────────────────

test("flow-0209 criterion 3: an intent already approved on base keeps both approval fields and status through a later edit", () => {
  const stamped = intent({ status: "approved", by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' });
  const edited = stamped + "an edit after approval\n";
  assert.deepEqual(run({ ".flow/intents/old.md": edited }, { ".flow/intents/old.md": stamped }), [],
    "the normal path does not touch it");
});

test("flow-0209 criterion 3: an intent with approved_by is never repaired, whatever its status", async () => {
  const text = intent({ status: "proposed", by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' });
  let asked = 0;
  const r = await repairIntents({
    paths: [".flow/intents/old.md"], read: () => text,
    findAddingMerge: async () => { asked++; return { pr: 9, mergedBy: BY, mergedAt: AT }; },
  });
  assert.deepEqual(r, { stamped: [], unresolved: [] });
  assert.equal(asked, 0, "no lookup is made for an intent that is already stamped");
});

test("flow-0209 criterion 3: a PR that edits an existing intent without adding it stamps nothing on the normal path", () => {
  assert.deepEqual(run({ ".flow/intents/a.md": intent() + "edit\n" }, { ".flow/intents/a.md": intent() }), []);
});

test("_TEMPLATE.md, nested and non-intent paths, deleted intents and frontmatter-less files are never stamped", () => {
  const files = {
    ".flow/intents/_TEMPLATE.md": intent(),
    "docs/intent-like.md": intent(),
    ".flow/intents/nested/deeper.md": intent(),
    ".flow/tasks/flow-0001-x.md": intent(),
    ".flow/intents/bare.md": "status: proposed\n",
  };
  assert.deepEqual(run(files), []);
  assert.deepEqual(stampIntents({ changed: [".flow/intents/gone.md"], read: () => null, mergedBy: BY, mergedAt: AT }), []);
  assert.equal(isIntentPath(".flow/intents/a.md"), true);
  for (const p of [".flow/intents/_TEMPLATE.md", ".flow/intents/a.txt", ".flow/intents/x/a.md",
    "project-template/.flow/intents/a.md", ".flow/intentsa.md", null]) {
    assert.equal(isIntentPath(p), false, String(p));
  }
  assert.equal(intentStatus("---\nid: x\n"), null, "an unclosed frontmatter has no status");
  assert.equal(intentStatus(null), null);
});

test("a re-run over an already-stamped tip changes nothing, so the push retry can tell it already landed", () => {
  const stamped = intent({ status: "approved", by: `"${BY}"`, at: `"${AT}"` });
  assert.deepEqual(run({ ".flow/intents/a.md": stamped }), []);
});

// ── flow-0209 criterion 4: superseded stays superseded ──────────────────────────────────────

test("flow-0209 criterion 4: the repair stamps a superseded intent's two approval fields and leaves its status superseded", async () => {
  const before = intent({ status: "superseded" });
  const { stamped, unresolved } = await repairIntents({
    paths: [".flow/intents/s.md"], read: () => before,
    findAddingMerge: async () => ({ pr: 12, mergedBy: "Adder", mergedAt: "2026-09-02T10:00:00Z" }),
  });
  assert.deepEqual(unresolved, []);
  assert.equal(stamped.length, 1);
  assert.match(stamped[0].text, /^status: "superseded" /m);
  assert.match(stamped[0].text, /^approved_by: "Adder" /m);
  assert.match(stamped[0].text, /^approved_at: "2026-09-02T10:00:00Z" /m);
  const a = before.split("\n"); const b = stamped[0].text.split("\n");
  assert.deepEqual(b.filter((l, i) => l !== a[i]).map((l) => l.split(":")[0]), ["approved_by", "approved_at"],
    "only the two approval fields changed");
  assert.match(approveText(intent({ status: "superseded" }), BY, AT), /^status: "superseded" /m,
    "the normal path keeps superseded too");
});

// ── byte preservation ───────────────────────────────────────────────────────────────────────

test("CRLF line endings and single-quoted values are kept; only the stamped values change", () => {
  const before = intent({ by: "''", at: "'2026-10-03'", eol: "\r\n" });
  const [r] = run({ ".flow/intents/a.md": before });
  assert.match(r.text, /\r\napproved_by: 'CandidDan' {11}# WRITTEN BY CI, NOT BY HAND\.\r\n/);
  assert.match(r.text, /\r\napproved_at: '2026-10-03T07:52:11Z' {11}# approval EVENT\r\n/);
  assert.equal(r.text.split("\r\n").length, before.split("\r\n").length);
  assert.doesNotMatch(r.text.replace(/\r\n/g, ""), /\n/, "no bare LF was introduced");
  assertOnlyStampedLinesDiffer(before, r.text, "\r\n");
});

test("stampText / approveText: a bare or empty value is written double-quoted; a missing field is added before the closing ---", () => {
  assert.equal(stampText("---\nstatus: approved\napproved_by:\napproved_at: 2026-10-03\n---\n", BY, AT),
    `---\nstatus: approved\napproved_by: "${BY}"\napproved_at: "${AT}"\n---\n`);
  assert.equal(stampText("---\r\nstatus: approved\r\n---\r\nbody\r\n", BY, AT),
    `---\r\nstatus: approved\r\napproved_by: "${BY}"\r\napproved_at: "${AT}"\r\n---\r\nbody\r\n`);
  assert.equal(approveText("---\nstatus: proposed\n---\n", BY, AT),
    `---\nstatus: "approved"\napproved_by: "${BY}"\napproved_at: "${AT}"\n---\n`);
  assert.throws(() => stampText("no frontmatter\n", BY, AT), /no frontmatter/);
});

test("intentStatus and intentApprovedBy read quoted, single-quoted and bare values", () => {
  assert.equal(intentStatus('---\nstatus: "approved"  # c\n---\n'), "approved");
  assert.equal(intentStatus("---\nstatus: 'approved'\n---\n"), "approved");
  assert.equal(intentStatus("---\nstatus: approved # c\n---\n"), "approved");
  assert.equal(intentApprovedBy('---\napproved_by: ""   # c\n---\n'), "");
  assert.equal(intentApprovedBy("---\napproved_by:\n---\n"), "");
  assert.equal(intentApprovedBy("---\napproved_by: x\n---\n"), "x");
  assert.equal(intentApprovedBy("---\nid: a\n---\n"), "", "absent reads as empty");
  assert.equal(intentApprovedBy(null), "");
  assert.equal(intentApprovedBy("no frontmatter"), "");
});

// ── a bad merge refuses rather than stamping something untrue ───────────────────────────────

test("a mergedAt that is not a full UTC instant, or an empty mergedBy, throws", () => {
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

test("the CLI exits non-zero, naming the problem, on a bad merge value or bad flags", () => {
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
  assert.throws(() => parseArgs(["--base", "a", "--head", "b", "--repo", "x/y/../z"]), /not owner\/name/);
  assert.deepEqual(parseArgs(["--base", "a", "--head", "b", "--repo", "Owner/re.po-1"]),
    { base: "a", head: "b", repo: "Owner/re.po-1" });
});

// ── the repair's lookup: unresolvable and failing cases (criterion 6), and its GitHub side ──

test("flow-0209 criterion 6: an intent whose adding PR cannot be found, or whose lookup fails, stays unstamped with a reason", async () => {
  const text = intent();
  const r = await repairIntents({
    paths: [".flow/intents/none.md", ".flow/intents/boom.md", ".flow/intents/bad.md", ".flow/intents/_TEMPLATE.md"],
    read: () => text,
    findAddingMerge: async (p) => {
      if (p.endsWith("none.md")) return null;
      if (p.endsWith("boom.md")) throw new Error("GitHub API answered HTTP 403");
      return { pr: 5, mergedBy: "", mergedAt: AT };
    },
  });
  assert.deepEqual(r.stamped, []);
  assert.deepEqual(r.unresolved.map((u) => u.path),
    [".flow/intents/bad.md", ".flow/intents/boom.md", ".flow/intents/none.md"]);
  assert.match(r.unresolved[0].reason, /PR #5: .*mergedBy is empty/);
  assert.match(r.unresolved[1].reason, /HTTP 403/);
  assert.match(r.unresolved[2].reason, /no merged pull request/);
});

// A fake `fetch` answering from a table of path -> JSON; anything else is a 404.
const fakeFetch = (table, seen = []) => async (url, init) => {
  seen.push({ url, init });
  const path = new URL(url).pathname;
  return path in table
    ? { ok: true, status: 200, json: async () => table[path] }
    : { ok: false, status: 404, json: async () => ({}) };
};
const SHA = "a".repeat(40);

test("addingMergeFromGitHub: the earliest merge into main among the commit's PRs, with merged_by read from the PR", async () => {
  const seen = [];
  const f = fakeFetch({
    [`/repos/o/r/commits/${SHA}/pulls`]: [
      { number: 3, merged_at: null, base: { ref: "main" } },
      { number: 4, merged_at: "2026-09-05T00:00:00Z", base: { ref: "main" } },
      { number: 2, merged_at: "2026-09-01T00:00:00Z", base: { ref: "feature" } },
      { number: 1, merged_at: "2026-09-03T00:00:00Z", base: { ref: "main" } },
    ],
    "/repos/o/r/pulls/1": { number: 1, merged_by: { login: "Adder" }, merged_at: "2026-09-03T00:00:00Z" },
  }, seen);
  assert.deepEqual(await addingMergeFromGitHub(SHA, { repo: "o/r", token: "t", fetchImpl: f }),
    { pr: 1, mergedBy: "Adder", mergedAt: "2026-09-03T00:00:00Z" });
  assert.equal(seen[0].init.headers.Authorization, "Bearer t");
  const anon = [];
  await addingMergeFromGitHub(SHA, { repo: "o/r", fetchImpl: fakeFetch({}, anon) }).catch(() => {});
  assert.equal(anon[0].init.headers.Authorization, undefined, "no token, no Authorization header");
});

test("addingMergeFromGitHub: no merged PR is null; an HTTP error and a bad repo or sha throw", async () => {
  const none = fakeFetch({ [`/repos/o/r/commits/${SHA}/pulls`]: [] });
  assert.equal(await addingMergeFromGitHub(SHA, { repo: "o/r", fetchImpl: none }), null);
  await assert.rejects(addingMergeFromGitHub(SHA, { repo: "o/r", fetchImpl: fakeFetch({}) }), /HTTP 404/);
  await assert.rejects(addingMergeFromGitHub(SHA, { repo: "bad", fetchImpl: none }), /not owner\/name/);
  await assert.rejects(addingMergeFromGitHub("HEAD", { repo: "o/r", fetchImpl: none }), /not a commit sha/);
});

// ── the CLI against a real repo ─────────────────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "commit.gpgsign", "false");
}

// History: PR #10 added `old.md` (merge commit), PR #11 added `orphan.md` (no PR found for it),
// `stamped.md` was added already approved. Then THIS merge's PR adds `new.md` and edits `old.md`.
function approvalRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stamp-intents-"));
  initRepo(dir);
  mkdirSync(join(dir, ".flow", "intents"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "x\n");
  writeFileSync(join(dir, ".flow/intents/stamped.md"),
    intent({ status: "approved", by: '"Earlier"', at: '"2026-09-01T00:00:00Z"' }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "root");
  git(dir, "checkout", "-qb", "pr10");
  writeFileSync(join(dir, ".flow/intents/old.md"), intent());
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "intent: old");
  const oldAdd = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "pr10", "-m", "Merge pull request #10");
  writeFileSync(join(dir, ".flow/intents/orphan.md"), intent());
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "intent: orphan, straight to main");
  const base = git(dir, "rev-parse", "HEAD");
  const orphanAdd = base;
  git(dir, "checkout", "-qb", "pr");
  writeFileSync(join(dir, ".flow/intents/new.md"), intent({ by: '"typed-by-author"' }));
  writeFileSync(join(dir, ".flow/intents/old.md"), intent() + "edited\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "intent: new");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "pr", "-m", "Merge pull request #37");
  return { dir, base, oldAdd, orphanAdd, head: git(dir, "rev-parse", "HEAD") };
}

const capture = () => {
  const lines = [];
  return { lines, sink: { write: (s) => lines.push(s) }, text: () => lines.join("") };
};

test("flow-0209 criteria 1, 5, 6: the CLI stamps the added intent from this merge and repairs the rest from the PR that added each", async () => {
  const { dir, base, head, oldAdd, orphanAdd } = approvalRepo();
  try {
    const seen = [];
    const fetchImpl = fakeFetch({
      // A commit pushed straight to main is associated with no PR: GitHub answers an empty list.
      [`/repos/o/r/commits/${orphanAdd}/pulls`]: [],
      [`/repos/o/r/commits/${oldAdd}/pulls`]: [{ number: 10, merged_at: "2026-09-10T09:00:00Z", base: { ref: "main" } }],
      "/repos/o/r/pulls/10": { number: 10, merged_by: { login: "Adder" }, merged_at: "2026-09-10T09:00:00Z" },
    }, seen);
    const out = capture(); const err = capture();
    const code = await runStampCli(
      ["--base", base, "--head", head, "--merged-by", BY, "--merged-at", AT, "--repo", "o/r"],
      { cwd: dir, out: out.sink, err: err.sink, env: { GH_TOKEN: "tok" }, fetchImpl });
    assert.equal(code, 0, err.text());

    // Criterion 1: the intent this merge added, from this merge — the author's typed value is gone.
    const added = readFileSync(join(dir, ".flow/intents/new.md"), "utf8");
    assert.match(added, /^status: "approved" /m);
    assert.match(added, /^approved_by: "CandidDan" /m);
    assert.match(added, /^approved_at: "2026-10-03T07:52:11Z" /m);

    // Criterion 5: old.md, which PR #10 added, gets PR #10's merge — NOT this merge's.
    const old = readFileSync(join(dir, ".flow/intents/old.md"), "utf8");
    assert.match(old, /^status: "approved" /m);
    assert.match(old, /^approved_by: "Adder" /m);
    assert.match(old, /^approved_at: "2026-09-10T09:00:00Z" /m);
    assert.doesNotMatch(old, /CandidDan|2026-10-03T07/);
    assert.ok(seen.every((s) => s.init.headers.Authorization === "Bearer tok"), "the token is sent");

    // Criterion 6: orphan.md has no PR — unstamped, exit 0, the log names it.
    const orphan = readFileSync(join(dir, ".flow/intents/orphan.md"), "utf8");
    assert.match(orphan, /^status: "proposed" /m);
    assert.match(orphan, /^approved_by: "" /m);
    assert.match(out.text(), /left unstamped \.flow\/intents\/orphan\.md: no merged pull request/);

    assert.deepEqual(out.lines.filter((l) => l.startsWith("stamped")), [
      `stamped .flow/intents/new.md: approved_by=${BY} approved_at=${AT}\n`,
      "stamped .flow/intents/old.md: approved_by=Adder approved_at=2026-09-10T09:00:00Z (repair, from PR #10)\n",
    ]);
    assert.equal(git(dir, "status", "--porcelain"), "M .flow/intents/new.md\n M .flow/intents/old.md".trim(),
      "stamped.md, already approved, is untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI without --repo stamps the added intent, skips the repair and names what is still unstamped", async () => {
  const { dir, base, head } = approvalRepo();
  try {
    const out = capture();
    const code = await runStampCli(["--base", base, "--head", head, "--merged-by", BY, "--merged-at", AT],
      { cwd: dir, out: out.sink, err: out.sink, fetchImpl: () => { throw new Error("no lookup expected"); } });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /repair skipped \(no --repo\) — still unstamped: \.flow\/intents\/old\.md, \.flow\/intents\/orphan\.md/);
    assert.match(readFileSync(join(dir, ".flow/intents/new.md"), "utf8"), /^approved_by: "CandidDan" /m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI in a shallow clone refuses to guess the adding commit: every pending intent is left unstamped, exit 0", async () => {
  const { dir, base, head } = approvalRepo();
  const shallow = mkdtempSync(join(tmpdir(), "stamp-shallow-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${dir}`, shallow]);
    const out = capture();
    const code = await runStampCli(["--base", base, "--head", head, "--merged-by", BY, "--merged-at", AT, "--repo", "o/r"],
      { cwd: shallow, out: out.sink, err: out.sink, fetchImpl: () => { throw new Error("no lookup expected"); } });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /left unstamped \.flow\/intents\/old\.md: the checkout is shallow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  }
});

test("with nothing to stamp and nothing to repair the CLI exits 0 and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-intents-"));
  try {
    initRepo(dir);
    mkdirSync(join(dir, ".flow", "intents"), { recursive: true });
    writeFileSync(join(dir, ".flow/intents/a.md"), intent({ status: "approved", by: `"${BY}"`, at: `"${AT}"` }));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const head = git(dir, "rev-parse", "HEAD");
    const out = capture();
    const code = await runStampCli(["--base", head, "--head", head, "--merged-by", BY, "--merged-at", AT, "--repo", "o/r"],
      { cwd: dir, out: out.sink, err: out.sink });
    assert.equal(code, 0);
    assert.match(out.text(), /nothing to stamp/);
    assert.equal(git(dir, "status", "--porcelain"), "", "the working tree is untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown revision fails the CLI with git's own error rather than stamping nothing quietly", async () => {
  const { dir } = approvalRepo();
  try {
    const err = capture();
    const code = await runStampCli(["--base", "0000000", "--head", "HEAD", "--merged-by", BY, "--merged-at", AT],
      { cwd: dir, out: { write: () => {} }, err: err.sink });
    assert.equal(code, 1);
    assert.match(err.text(), /0000000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
