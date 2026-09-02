// release-guard.test.mjs — proving tests for the release guard (flow-0024).
//
// The incident this pins down (2026-08-19): `v1.1.1` was cut to publish the touches-guard
// fail-open fix, onto a commit whose `VERSION` still read `1.1.0`. flow-sync compares stamps
// and nothing else, so it saw 1.1.0 against 1.1.0, decided `current`, and reported success
// nightly while the fix reached nobody.
//
// The incident was then MISDIAGNOSED, and that misdiagnosis is why the fixtures below use
// ANNOTATED tags. A handoff read `9a29a00` — the annotated *tag object* sha for v1.1.1 — as a
// commit and concluded v1.1.1 tagged an earlier tree than it did. A fixture built only from
// lightweight tags reproduces none of that and passes trivially, so the annotated-tag test
// asserts the two shas actually differ before it asserts which one was read.
//
// Split, matching the module: pure-verdict tests need no repo at all; the git layer is proved
// against real temp repos with no remote.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aliasForVersion,
  checkRelease,
  collectFacts,
  commitDistance,
  formatReport,
  highestReleaseTag,
  listReleaseTags,
  makeGitRunner,
  parseFlags,
  readFileAtRef,
  reportAndExit,
  resolveCommit,
  runReleaseGuard,
  versionAtRef,
  RELEASE_TAG,
  ROOT_VERSION_PATH,
  TEMPLATE_VERSION_PATH,
} from "./release-guard.mjs";

// ── fixtures ───────────────────────────────────────────────────────────────────────────
const repos = [];

function makeRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `flow-rg-${name}-`));
  repos.push(dir);
  const git = (...a) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "guard@flow.test");
  git("config", "user.name", "release guard fixture");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  return { dir, git, runner: makeGitRunner(dir) };
}

// Write both stamps with NO trailing newline — exactly how canonical's two VERSION files sit on
// disk. `_flow-sync.yml` writes an adopted repo's stamp with `printf '%s\n'`, so anything that
// compared bytes rather than trimmed values would pass here and fail across the adopt boundary.
function stamp(dir, rootVersion, templateVersion = rootVersion) {
  mkdirSync(join(dir, "project-template", ".flow"), { recursive: true });
  writeFileSync(join(dir, ROOT_VERSION_PATH), rootVersion);
  writeFileSync(join(dir, TEMPLATE_VERSION_PATH), templateVersion);
}

function commit({ dir, git }, message) {
  writeFileSync(join(dir, "log.txt"), `${message}\n`);
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD").trim();
}

test.after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

// A tree whose tag, stamps and aliases all agree. Nothing should have anything to say about it.
function healthyRepo() {
  const r = makeRepo("healthy");
  stamp(r.dir, "1.2.0");
  commit(r, "release 1.2.0");
  r.git("tag", "-a", "v1.2.0", "-m", "1.2.0");
  r.git("tag", "v1");            // lightweight alias, at the tip — nothing behind
  r.git("tag", "v1-edge");
  return r;
}

// The 2026-08-19 tree: v1.1.1 cut onto a commit still stamped 1.1.0, main since moved on, and
// `v1` left parked at the 1.1.0 release.
function incidentRepo() {
  const r = makeRepo("incident");
  stamp(r.dir, "1.1.0");
  commit(r, "release 1.1.0");
  r.git("tag", "-a", "v1.1.0", "-m", "1.1.0");
  r.git("tag", "v1");            // the fleet's pin, parked here and forgotten
  commit(r, "touches-guard: fail closed");
  r.git("tag", "-a", "v1.1.1", "-m", "1.1.1");   // annotated, and the stamp was never bumped
  commit(r, "more work on main");
  commit(r, "still more work on main");
  return r;
}

// ── pure verdict ───────────────────────────────────────────────────────────────────────

test("a tag whose commit carries the matching stamp reports no problems", () => {
  const { problems } = checkRelease({
    tag: "v1.2.0", tagVersion: "1.2.0", rootVersion: "1.2.0", templateVersion: "1.2.0",
  });
  assert.deepEqual(problems, [], "an agreeing tag/stamp pair must be clean");
});

test("a tag whose commit carries a different stamp is a problem naming tag, found and expected", () => {
  const { problems } = checkRelease({
    tag: "v1.1.1", tagVersion: "1.1.0", rootVersion: "1.1.0", templateVersion: "1.1.0",
  });
  assert.equal(problems.length, 1);
  const [p] = problems;
  assert.match(p, /v1\.1\.1/, "must name the tag");
  assert.match(p, /1\.1\.0/, "must name the stamp it found");
  assert.match(p, /expected 1\.1\.1/, "must name the stamp it expected");
});

test("the two stamps disagreeing is a problem naming both paths and both values", () => {
  const { problems } = checkRelease({ rootVersion: "1.2.0", templateVersion: "1.1.0" });
  assert.equal(problems.length, 1);
  const [p] = problems;
  assert.match(p, /VERSION/, "must name the root stamp path");
  assert.match(p, /project-template\/\.flow\/VERSION/, "must name the template stamp path");
  assert.match(p, /1\.2\.0/, "must name the root value");
  assert.match(p, /1\.1\.0/, "must name the template value");
});

test("two agreeing stamps are SILENT — no problem and no warning, not 'ok' noise", () => {
  const { problems, warnings } = checkRelease({ rootVersion: "1.2.0", templateVersion: "1.2.0" });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, [], "an agreeing pair must contribute nothing at all");
});

test("trailing whitespace never counts as stamp drift (canonical has none, adopted repos do)", () => {
  const { problems, warnings } = checkRelease({ rootVersion: "1.2.0", templateVersion: "1.2.0\n" });
  assert.deepEqual(problems, [], "stamps are compared trimmed — `printf '%s\\n'` is not drift");
  assert.deepEqual(warnings, []);
});

test("main ahead of the last release tag with the stamp unmoved is a warning naming N and the tag", () => {
  const { problems, warnings } = checkRelease({
    rootVersion: "1.1.0", templateVersion: "1.1.0",
    latestReleaseTag: "v1.1.1", latestReleaseVersion: "1.1.0", mainAhead: 7, mainRef: "main",
  });
  assert.deepEqual(problems, [], "silent staleness is information, never a release failure");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\b7\b/, "must name how many commits");
  assert.match(warnings[0], /v1\.1\.1/, "must name the tag it is measuring from");
});

test("main ahead of the last release tag with the stamp already bumped says nothing", () => {
  const { problems, warnings } = checkRelease({
    rootVersion: "1.2.0", templateVersion: "1.2.0",
    latestReleaseTag: "v1.1.1", latestReleaseVersion: "1.1.0", mainAhead: 7,
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, [], "a release in flight is normal and legible — not a finding");
});

test("v1 behind main is a warning naming N and both refs, and NEVER a problem", () => {
  const { problems, warnings } = checkRelease({
    rootVersion: "1.2.0", templateVersion: "1.2.0",
    aliasRef: "v1", aliasBehind: 74, mainRef: "main",
  });
  assert.deepEqual(problems, [],
    "moving v1 is a deliberate human step; failing the release on it just gets bypassed");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\b74\b/, "must name the distance");
  assert.match(warnings[0], /v1\b/, "must name the alias");
  assert.match(warnings[0], /main/, "must name what it is behind");
});

test("an alias level with main contributes no warning", () => {
  const { warnings } = checkRelease({
    rootVersion: "1.2.0", templateVersion: "1.2.0", aliasRef: "v1", aliasBehind: 0,
  });
  assert.deepEqual(warnings, []);
});

for (const bad of ["1.2", "v1.2.0", "1.2.0-rc1", "latest"]) {
  test(`a VERSION of "${bad}" is a problem, not something to parse into a comparison`, () => {
    const { problems } = checkRelease({ rootVersion: bad, templateVersion: "1.2.0" });
    assert.ok(problems.some((p) => p.includes(ROOT_VERSION_PATH) && p.includes(bad)),
      "must report the path and the unparseable value");
    assert.ok(!problems.some((p) => p.startsWith("stamp drift")),
      "must NOT go on to compare an unparseable stamp against the other one");
  });
}

test("a missing stamp is a problem naming the path", () => {
  const { problems } = checkRelease({ rootVersion: null, templateVersion: "1.2.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^VERSION: no stamp found/);
});

for (const alias of ["v1", "v1-edge", "v2-edge", "main", ""]) {
  test(`"${alias}" is skipped by the tag/stamp check rather than failed`, () => {
    const { problems, warnings } = checkRelease({
      tag: alias, tagVersion: "9.9.9", rootVersion: "1.2.0", templateVersion: "1.2.0",
    });
    assert.deepEqual(problems, [],
      "the floating aliases are expected not to carry a matching stamp");
    assert.deepEqual(warnings, []);
  });
}

test("a release tag whose stamp cannot be read is a problem, not a silent pass", () => {
  const { problems } = checkRelease({
    tag: "v1.2.0", tagVersion: null, rootVersion: "1.2.0", templateVersion: "1.2.0",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not read/);
});

test("problems accumulate rather than short-circuiting", () => {
  const { problems, warnings } = checkRelease({
    tag: "v1.3.0", tagVersion: "1.1.0", rootVersion: "1.2.0", templateVersion: "1.1.0",
    aliasRef: "v1", aliasBehind: 5, mainRef: "main",
  });
  assert.equal(problems.length, 2, "stamp drift AND tag disagreement must both be reported");
  assert.equal(warnings.length, 1, "warnings are still collected alongside problems");
});

// ── pure helpers ───────────────────────────────────────────────────────────────────────

test("highestReleaseTag ignores the floating aliases and orders numerically, not lexically", () => {
  assert.equal(
    highestReleaseTag(["v1.9.0", "v1.10.0", "v1", "v1-edge", "v1.2.0"]),
    "v1.10.0",
    "a lexical sort would pick v1.9.0 and quietly measure against the wrong release",
  );
  assert.equal(highestReleaseTag(["v1", "v1-edge"]), null);
  assert.equal(highestReleaseTag([]), null);
  assert.equal(highestReleaseTag(), null);
});

test("aliasForVersion derives the fleet's pin, and refuses an unparseable stamp", () => {
  assert.equal(aliasForVersion("1.2.0"), "v1");
  assert.equal(aliasForVersion("2.0.1"), "v2");
  assert.equal(aliasForVersion("1.2.0\n"), "v1");
  assert.equal(aliasForVersion("1.2"), null);
  assert.equal(aliasForVersion(null), null);
});

test("RELEASE_TAG matches releases and not aliases", () => {
  assert.ok(RELEASE_TAG.test("v1.2.0"));
  assert.ok(!RELEASE_TAG.test("v1"));
  assert.ok(!RELEASE_TAG.test("v1-edge"));
  assert.ok(!RELEASE_TAG.test("1.2.0"));
});

test("parseFlags reads values and bare switches", () => {
  assert.deepEqual(parseFlags(["--tag", "v1.2.0", "--json", "--main", "HEAD"]),
    { tag: "v1.2.0", json: true, main: "HEAD" });
  assert.deepEqual(parseFlags(["stray", "--json"]), { json: true });
  assert.deepEqual(parseFlags([]), {});
});

// ── git layer, against real repos with no remote ───────────────────────────────────────

test("an ANNOTATED tag is read at <tag>^{commit}, never at the tag object", () => {
  const r = incidentRepo();
  const tagObject = r.git("rev-parse", "v1.1.1").trim();
  const tagCommit = r.git("rev-parse", "v1.1.1^{commit}").trim();

  // The assertion that makes the rest of this test mean anything: if the fixture's tag were
  // lightweight these would be equal, the test would pass against a broken implementation, and
  // it would reproduce nothing. This is the exact pair (9a29a00 vs d751e97) that was misread.
  assert.notEqual(tagObject, tagCommit,
    "fixture must use an ANNOTATED tag — a lightweight one proves nothing here");

  assert.equal(resolveCommit(r.runner, "v1.1.1"), tagCommit,
    "resolveCommit must peel the tag object to its commit — `rev-parse v1.1.1` alone returns " +
    "the tag object, and an implementation that stopped there would return " + tagObject);

  const read = versionAtRef(r.runner, "v1.1.1", ROOT_VERSION_PATH);
  assert.equal(read.version, "1.1.0");
  assert.equal(read.commit, tagCommit, "must report the commit it actually read");
  assert.notEqual(read.commit, tagObject,
    "REGRESSION: the guard is reporting the tag OBJECT as the commit it read");

  // Why the SHA has to be the commit, when git peels tags for us almost everywhere. `git show
  // <rev>:<path>` and `rev-list <rev>..main` both dereference, so the stamp and the distances
  // would have come out right either way. What does NOT peel is a human — or a report — holding
  // the sha up against a commit listing: a tag-object sha is not on main and never will be, so
  // whoever compares them concludes the tag points somewhere off the branch. That is exactly
  // the wrong diagnosis drawn on 2026-08-19 (9a29a00 read as a commit, when d751e97 was one).
  // The guard therefore reports the peeled commit, and this asserts which side of that line
  // each sha falls on.
  const onMain = r.git("rev-list", "main").trim().split("\n");
  assert.ok(onMain.includes(tagCommit), "the commit v1.1.1 tags is on main");
  assert.ok(!onMain.includes(tagObject),
    "the tag OBJECT is not on main and never will be — reporting it is what caused the misread");
});

test("versionAtRef reports nothing for a ref that does not exist", () => {
  const r = healthyRepo();
  assert.deepEqual(versionAtRef(r.runner, "v9.9.9", ROOT_VERSION_PATH),
    { commit: null, version: null });
  assert.equal(resolveCommit(r.runner, "nope"), null);
  assert.equal(readFileAtRef(r.runner, "HEAD", "no/such/file"), null);
});

test("listReleaseTags returns releases only", () => {
  const r = incidentRepo();
  assert.deepEqual(listReleaseTags(r.runner).sort(), ["v1.1.0", "v1.1.1"],
    "v1 is an alias and must not be offered as a release");
});

test("commitDistance counts one way and reports null for a missing ref", () => {
  const r = incidentRepo();
  assert.equal(commitDistance(r.runner, "v1.1.1", "HEAD"), 2);
  assert.equal(commitDistance(r.runner, "HEAD", "v1.1.1"), 0);
  assert.equal(commitDistance(r.runner, "v9.9.9", "HEAD"), null);
});

test("the healthy repo produces no problems and no warnings, end to end", () => {
  const r = healthyRepo();
  const verdict = runReleaseGuard({ git: r.runner, tag: "v1.2.0" });
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.facts.tagVersion, "1.2.0");
  assert.equal(verdict.facts.aliasRef, "v1", "the alias is derived from the stamp when unset");
});

test("the 2026-08-19 incident reproduces: v1.1.1 fails, with staleness and alias rot measured", () => {
  const r = incidentRepo();
  const { problems, warnings, facts } = runReleaseGuard({ git: r.runner, tag: "v1.1.1" });

  assert.equal(problems.length, 1, "the tag/stamp disagreement is the failure");
  assert.match(problems[0], /v1\.1\.1 tags a tree whose .*VERSION.* reads 1\.1\.0, expected 1\.1\.1/);

  assert.equal(facts.mainAhead, 2);
  assert.ok(warnings.some((w) => /2 commit\(s\) ahead of v1\.1\.1/.test(w)),
    "staleness on main must be measured");
  assert.equal(facts.aliasBehind, 3);
  assert.ok(warnings.some((w) => /v1 is 3 commit\(s\) behind main/.test(w)),
    "alias rot must be measured, with a number");
});

test("a non-release ref falls back to the highest release tag rather than checking nothing", () => {
  const r = incidentRepo();
  // What the workflow actually passes on a push to main: GITHUB_REF_NAME === "main".
  const { facts, problems } = runReleaseGuard({ git: r.runner, tag: "main" });
  assert.equal(facts.tag, "v1.1.1", "must re-check the newest published stamp on every push");
  assert.equal(problems.length, 1, "so the incident is caught by the next push, not only at cut time");
});

test("the documented repair clears it: a newer release tag on a tree whose stamp is true", () => {
  // A published tag is history and cannot be un-lied. The guard follows the NEWEST release, so
  // the repair a human can actually make — cut the next release properly — is the one that
  // turns it green. This is asserted because the failure message promises it.
  const r = incidentRepo();
  assert.equal(runReleaseGuard({ git: r.runner, tag: "main" }).problems.length, 1,
    "sanity: v1.1.1 is the newest release and it lies");

  stamp(r.dir, "1.2.0");
  commit(r, "stamp 1.2.0");
  r.git("tag", "-a", "v1.2.0", "-m", "1.2.0");

  const { problems, facts } = runReleaseGuard({ git: r.runner, tag: "main" });
  assert.equal(facts.tag, "v1.2.0", "the newest release is now the one under scrutiny");
  assert.deepEqual(problems, [], "and it tells the truth, so the release path is unblocked");
});

test("stamp drift is caught end to end, from the tree the workflow is about to publish", () => {
  const r = makeRepo("drift");
  stamp(r.dir, "1.2.0", "1.1.0");            // root bumped, template stamp left behind
  commit(r, "bump the wrong half");
  r.git("tag", "-a", "v1.2.0", "-m", "1.2.0");

  const { problems } = runReleaseGuard({ git: r.runner, tag: "v1.2.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^stamp drift/);
  assert.match(problems[0], /flow-sync compares project-template\/\.flow\/VERSION/);
});

test("a repo with no tags at all reports nothing rather than crashing", () => {
  const r = makeRepo("untagged");
  stamp(r.dir, "1.2.0");
  commit(r, "no tags here");
  const { problems, warnings, facts } = runReleaseGuard({ git: r.runner, tag: "main" });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, [], "with no tag and no alias there is no distance to report");
  assert.equal(facts.latestReleaseTag, null);
});

test("an explicit --alias overrides the one derived from the stamp", () => {
  const r = incidentRepo();
  const { facts } = runReleaseGuard({ git: r.runner, tag: "v1.1.1", aliasRef: "v1.1.0" });
  assert.equal(facts.aliasRef, "v1.1.0");
  assert.equal(facts.aliasBehind, 3);
});

test("collectFacts defaults are the ones the CLI relies on", () => {
  const r = healthyRepo();
  const facts = collectFacts({ git: r.runner });
  assert.equal(facts.mainRef, "main", "the label used in messages, not the ref that was read");
  assert.equal(facts.rootPath, ROOT_VERSION_PATH);
  assert.equal(facts.templatePath, TEMPLATE_VERSION_PATH);
  assert.equal(facts.tag, "v1.2.0", "an empty tag falls back to the highest release");
});

// ── report + exit ──────────────────────────────────────────────────────────────────────

test("formatReport annotates warnings and errors the way GitHub reads them", () => {
  const lines = formatReport({
    facts: { tag: "v1.1.1", tagCommit: "d751e97abcdef" },
    problems: ["boom"], warnings: ["heads up"],
  });
  assert.match(lines[0], /release-guard: v1\.1\.1 \(d751e97\) — 1 problem\(s\), 1 warning\(s\)/);
  assert.ok(lines.includes("::warning::release-guard: heads up"));
  assert.ok(lines.includes("::error::release-guard: boom"));
});

test("formatReport says so when there is nothing to say", () => {
  const lines = formatReport({ facts: { tag: "" }, problems: [], warnings: [] });
  assert.match(lines[0], /<no release tag> — 0 problem\(s\), 0 warning\(s\)/);
  assert.match(lines[1], /stamps agree/);
});

test("reportAndExit exits 1 on a problem and 0 otherwise", () => {
  const codes = [];
  const exit = (c) => codes.push(c);
  reportAndExit({ facts: {}, problems: ["boom"], warnings: [] }, { log: () => {}, exit });
  reportAndExit({ facts: {}, problems: [], warnings: ["meh"] }, { log: () => {}, exit });
  assert.deepEqual(codes, [1, 0], "warnings must never fail the release path");
});

test("reportAndExit --json emits the whole verdict", () => {
  const out = [];
  reportAndExit({ facts: { tag: "v1.2.0" }, problems: [], warnings: [] },
    { json: true, log: (s) => out.push(s), exit: () => {} });
  assert.deepEqual(JSON.parse(out[0]), { facts: { tag: "v1.2.0" }, problems: [], warnings: [] });
});

// ── the CLI actually runs ──────────────────────────────────────────────────────────────

test("the CLI exits non-zero on a disagreeing stamp and zero on an agreeing one", () => {
  const bad = incidentRepo();
  const good = healthyRepo();
  const run = (repo, args) =>
    execFileSync(process.execPath,
      [join(import.meta.dirname, "release-guard.mjs"), "--repo", repo.dir, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  let code = 0, stdout = "";
  try { run(bad, ["--tag", "v1.1.1"]); } catch (e) { code = e.status; stdout = e.stdout; }
  assert.equal(code, 1, "a lying stamp must fail the release path, not pass it quietly");
  assert.match(stdout, /::error::release-guard: v1\.1\.1 tags a tree/);

  const ok = run(good, ["--tag", "v1.2.0"]);
  assert.match(ok, /0 problem\(s\), 0 warning\(s\)/);
});

test("the CLI reads the tag from GITHUB_REF_NAME when no --tag is passed", () => {
  const bad = incidentRepo();
  let code = 0, stdout = "";
  try {
    execFileSync(process.execPath,
      [join(import.meta.dirname, "release-guard.mjs"), "--repo", bad.dir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GITHUB_REF_NAME: "main" } });
  } catch (e) { code = e.status; stdout = e.stdout; }
  assert.equal(code, 1, "a push to main must still re-check the newest published stamp");
  assert.match(stdout, /v1\.1\.1/);
});
