// Tests for flow-sync — the adopt mechanism's pure brain (version decision + PR text).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide, syncBranch, decideExisting, CANONICAL_SHA_TRAILER, prContent,
  topLevelJobKeys, extraJobs, parseKept,
} from "./flow-sync.mjs";

// ── decide ──

test("behind: local strictly older than canonical → sync", () => {
  assert.equal(decide("1.0.0", "1.2.0"), "behind");
  assert.equal(decide("1.0.0", "2.0.0"), "behind");
  assert.equal(decide("1.1.9", "1.2.0"), "behind");
});

test("current: equal versions → nothing to do", () => {
  assert.equal(decide("1.2.0", "1.2.0"), "current");
});

test("current: short/long and v-prefixed forms compare equal (tag v1 vs stamp 1.0.0)", () => {
  // The canonical tag is `v1` while the VERSION stamp is `1.0.0`; compareVersions pads and
  // strips the prefix, so these must not read as drift.
  assert.equal(decide("1.0.0", "v1"), "current");
  assert.equal(decide("1", "1.0.0"), "current");
});

test("ahead: repo newer than canonical → never sync backwards", () => {
  assert.equal(decide("1.3.0", "1.2.0"), "ahead");
  assert.equal(decide("2.0.0", "v1"), "ahead");
});

test("behind: a missing/empty local stamp adopts the stamp + infra", () => {
  assert.equal(decide("", "1.0.0"), "behind");
  assert.equal(decide(undefined, "1.0.0"), "behind");
});

test("decide throws when canonical version is absent", () => {
  assert.throws(() => decide("1.0.0", ""), /canonical version is required/);
});

// ── syncBranch ──

test("syncBranch is stable per target version (idempotent reuse)", () => {
  assert.equal(syncBranch("1.2.0"), "flow-sync/1.2.0");
  assert.equal(syncBranch("1.2.0"), syncBranch("1.2.0"));
});

// ── decideExisting (flow-0075) ──
//
// The four verdicts are the four rows of the task's table. Each test is named for the acceptance
// criterion it proves, and the Nudge case — a branch that outlived a closed-unmerged PR — is
// called out by name because it is the one the old code answered `noop` to.

const SHA_NOW = "f1e2d3c4b5a6978877665544332211aabbccddee";
const SHA_OLD = "0011223344556677889900aabbccddeeff001122";

test("decideExisting: no sync branch → create (today's path, unchanged)", () => {
  assert.equal(decideExisting({
    branchExists: "no", openPr: "", headCanonicalSha: "", canonicalSha: SHA_NOW,
  }), "create");
  // The other facts are irrelevant when the branch is absent, and must not change the answer.
  assert.equal(decideExisting({
    branchExists: false, openPr: "286", headCanonicalSha: SHA_NOW, canonicalSha: SHA_NOW,
  }), "create");
});

test("decideExisting: branch exists, no open PR → rebuild (the Nudge#286 case)", () => {
  // `flow-sync/2.0.0` survived a PR closed without merging. Before flow-0075 every later run
  // logged "a sync PR for 2.0.0 is already open" and exited 0, so that version could never be
  // offered again. The recorded SHA is deliberately EQUAL here: with no open PR there is nothing
  // to carry the branch to review, so the branch must be rebuilt and a PR opened regardless.
  assert.equal(decideExisting({
    branchExists: "yes", openPr: "", headCanonicalSha: SHA_NOW, canonicalSha: SHA_NOW,
  }), "rebuild");
  assert.equal(decideExisting({
    branchExists: "yes", openPr: "", headCanonicalSha: SHA_OLD, canonicalSha: SHA_NOW,
  }), "rebuild");
  assert.equal(decideExisting({
    branchExists: "yes", openPr: null, headCanonicalSha: "", canonicalSha: SHA_NOW,
  }), "rebuild");
});

test("decideExisting: open PR whose head records a DIFFERENT canonical SHA → refresh", () => {
  // Nudge's branch was also built from an older `v2` on an older `main`, so reopening it would
  // have regressed the repo. A stale head under an open PR is rebuilt in place; the PR picks the
  // new head up by itself, so no second PR is opened.
  assert.equal(decideExisting({
    branchExists: "yes", openPr: "286", headCanonicalSha: SHA_OLD, canonicalSha: SHA_NOW,
  }), "refresh");
});

test("decideExisting: open PR whose head has NO Canonical-SHA trailer → refresh, not noop", () => {
  // Every branch built before flow-0075 is in this state. Absent counts as stale — the safe
  // direction, because the worst case is one unnecessary rebuild, while the other direction is
  // exactly the silent green this task removes.
  for (const missing of ["", null, undefined, "   "]) {
    assert.equal(decideExisting({
      branchExists: "yes", openPr: "286", headCanonicalSha: missing, canonicalSha: SHA_NOW,
    }), "refresh", `a head with ${JSON.stringify(missing)} recorded must not read as current`);
  }
});

test("decideExisting: open PR whose head records the SAME canonical SHA → noop", () => {
  assert.equal(decideExisting({
    branchExists: "yes", openPr: "286", headCanonicalSha: SHA_NOW, canonicalSha: SHA_NOW,
  }), "noop");
  // Trailer values arrive off a commit message, so whitespace and case must not manufacture a
  // needless rebuild on every single run.
  assert.equal(decideExisting({
    branchExists: "yes", openPr: 286, headCanonicalSha: ` ${SHA_NOW.toUpperCase()}\n`, canonicalSha: SHA_NOW,
  }), "noop");
});

test("decideExisting: an ungathered fact throws — it never falls back to noop", () => {
  // The whole point of the subcommand. A fact the workflow could not gather must stop the run,
  // because `noop` is indistinguishable from success in a log.
  assert.throws(() => decideExisting({
    branchExists: "maybe", openPr: "", headCanonicalSha: "", canonicalSha: SHA_NOW,
  }), /--branch-exists must be yes or no/);
  assert.throws(() => decideExisting({
    branchExists: "yes", openPr: "gh: could not find any commits", canonicalSha: SHA_NOW,
  }), /--open-pr must be a PR number or empty/);
  assert.throws(() => decideExisting({
    branchExists: "yes", openPr: "286", headCanonicalSha: SHA_NOW, canonicalSha: "",
  }), /canonical SHA is required/);
  assert.throws(() => decideExisting(), /canonical SHA is required/);
});

test("decideExisting: an empty canonical SHA cannot compare equal to an empty trailer", () => {
  // The specific way a missing SHA would have produced a false `noop` had it been allowed
  // through: "" === "" is true, and both sides are empty exactly when nothing was gathered.
  assert.throws(() => decideExisting({
    branchExists: "yes", openPr: "286", headCanonicalSha: "", canonicalSha: "",
  }), /canonical SHA is required/);
});

test("the Canonical-SHA trailer key has one definition, shared with the workflow's assertions", () => {
  assert.equal(CANONICAL_SHA_TRAILER, "Canonical-SHA");
});

// ── prContent ──

test("prContent: title names the target version", () => {
  assert.equal(prContent({ local: "1.0.0", canonical: "1.2.0" }).title,
    "flow: adopt canonical Flow infra 1.2.0");
});

test("prContent: body lists each changed file and the version transition", () => {
  const { body } = prContent({
    local: "1.0.0", canonical: "1.2.0",
    files: [".flow/bin/flow-doctor.mjs", ".flow/VERSION"],
  });
  assert.match(body, /`1\.0\.0` → `1\.2\.0`/);
  assert.match(body, /- `\.flow\/bin\/flow-doctor\.mjs`/);
  assert.match(body, /- `\.flow\/VERSION`/);
});

test("prContent: empty file list is reported as version-stamp-only, not a blank section", () => {
  const { body } = prContent({ local: "1.0.0", canonical: "1.2.0", files: [] });
  assert.match(body, /version stamp only/);
});

test("prContent: a missing local stamp renders as (none) in the transition", () => {
  const { body } = prContent({ local: "", canonical: "1.0.0" });
  assert.match(body, /`\(none\)` → `1\.0\.0`/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// flow-0054 — the file list a sync PR body carries.
//
// The defect: `_flow-sync.yml` computed `CHANGED="$(git diff --name-only)"` on the line BEFORE
// `git add -A`. That is the unstaged worktree diff, which covers TRACKED files only, so every
// newly created file was invisible to it. The commit and the push were always correct; only the
// list handed to `pr-body` was wrong — and `pr-body` renders an empty list as
// "version stamp only — no infra files differed", so a sync whose payload is entirely new files
// opened a PR whose body affirmatively denied its own diff.
//
// Two shapes, one defect. The all-additions shape produces the false sentence. The mixed shape,
// observed live at TanPlan#26 (37 files: 22 modified, 15 added; the body listed the 22), is the
// more dangerous one: `version stamp only` against 6489 added lines is self-evidently absurd and
// a reviewer stops, while a plausible 22-item list against a 37-file diff reads as complete.
//
// The asymmetry that decides how these fixtures are built: DELETIONS were always reported
// correctly, because `rsync -a --delete` removes tracked files and the worktree diff lists them.
// A fixture of modifications and deletions alone therefore PASSES against the broken code and
// proves nothing. Every fixture below that claims to prove the fix creates untracked files, and
// the all-additions one asserts the discriminator explicitly.
//
// The shell is LIFTED FROM THE SHIPPED WORKFLOW, not reimplemented — the same technique
// `.flow/bin/sync-permissions.test.mjs` uses for the copy loop. The bug is an ORDERING between
// two lines of that shell; a test that restates the ordering could only ever prove its own
// restatement.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChanges } from "./flow-sync.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));

// `_flow-sync.yml` is the REUSABLE, and it exists only in canonical — an adopting repo holds the
// thin caller by reference and never has a copy. Canonical also keeps this file one level deeper
// than an adopting repo does (`project-template/.flow/bin/` vs `.flow/bin/`), so the reusable is
// found by walking up rather than at a fixed depth. Bounded at four levels so a miss stops inside
// the checkout instead of wandering up the filesystem. Absent → the workflow tests skip visibly.
function findUp(rel) {
  let dir = BIN;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

const REUSABLE = findUp(".github/workflows/_flow-sync.yml");
const CALLER = findUp(".github/workflows/flow-sync.yml");
const skipReusable = REUSABLE
  ? false
  : "no .github/workflows/_flow-sync.yml here — this repo adopted the thin caller, not the reusable";
const skipCaller = CALLER ? false : "no .github/workflows/flow-sync.yml here";

// Lifted verbatim from the shipped `run:` script: everything from the git identity through the
// line that computes the file list, which is exactly the region the ordering lives in. Read as
// raw text rather than through a YAML parser on purpose — this file is copied into repos whose
// flow-tooling job runs `node --test` with no install step, so it must not need `yaml`. A literal
// block scalar has no escaping, so its lines are the shell's lines, and bash ignores the leading
// indentation YAML gives them.
//
// If this stops matching, the step was reshaped: re-read it and update the extractor. Never relax
// it into something that matches a reimplementation.
const STAGE_AND_LIST = /^[ \t]*git config user\.name\b[\s\S]*?^[ \t]*CHANGED="\$\(git diff[^\n]*\)"$/m;

function liftStageAndList() {
  const match = readFileSync(REUSABLE, "utf8").match(STAGE_AND_LIST);
  assert.ok(match, "could not find the stage-then-list block in _flow-sync.yml — it was reshaped; " +
    "update this extractor and re-verify the behaviour below still holds");
  return match[0];
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function write(repo, rel, content) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

/** A repo at an older Flow, with `baseline` already committed. */
function fixtureRepo(t, baseline) {
  const repo = mkdtempSync(join(tmpdir(), "flow-sync-body-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "fixture");
  for (const [rel, content] of Object.entries(baseline)) write(repo, rel, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture: repo at an older Flow");
  return repo;
}

/**
 * Run the workflow's own stage-then-list shell in `repo` and return what it put in `CHANGED`.
 * The block sets a variable and nothing more, so the only addition is a `printf` of that
 * variable — the lifted lines themselves are untouched.
 */
function runStageAndList(repo) {
  return execFileSync(
    "bash",
    ["-euo", "pipefail", "-c", `${liftStageAndList()}\nprintf '%s\\n' "$CHANGED"`],
    { cwd: repo, encoding: "utf8", env: { ...process.env, BRANCH: "flow-sync/2.0.0" } },
  );
}

// ── the shipped ordering ──

test("the shipped shell stages before it lists, and reads the staged tree", { skip: skipReusable }, () => {
  const block = liftStageAndList();
  const add = block.indexOf("git add -A");
  const changed = block.indexOf('CHANGED="$(git diff');
  assert.ok(add >= 0, "the lifted block must still contain the `git add -A` that stages the sync");
  assert.ok(add < changed,
    "`git add -A` must come BEFORE the file list is computed — the reverse is flow-0054: newly " +
    "created files are untracked until the add, so a list computed first omits every one of them");
  assert.match(block, /CHANGED="\$\(git diff --cached\b/,
    "the list must be read from the STAGED tree (`--cached`). Without it the command reports the " +
    "unstaged worktree diff, which after `git add -A` is empty — the same bug with the opposite " +
    "symptom: every file missing instead of only the new ones");
});

// ── the shape that produced the false sentence ──

test("a sync of entirely new files lists them, and never says 'version stamp only'", { skip: skipReusable }, (t) => {
  const repo = fixtureRepo(t, { "README.md": "a repo that has never adopted Flow\n" });

  // TanPlan's shape: no `.flow/VERSION` at all, so the stamp itself is created too and the whole
  // payload is additions. Two of the three are files that will execute in this repo's CI.
  write(repo, ".flow/VERSION", "2.0.0\n");
  write(repo, ".flow/bin/flow-doctor.mjs", "// synced\n");
  write(repo, ".github/workflows/flow-compass.yml", "name: flow-compass\n");

  // THE DISCRIMINATOR. This is what the workflow used to hand to `pr-body`, and it is empty —
  // so a fixture built from modifications alone would pass against the broken code. Assert it,
  // rather than trusting the note: if a future change makes these files tracked, this fixture
  // stops proving anything and should fail loudly here instead of silently going green.
  assert.equal(git(repo, "diff", "--name-only").trim(), "",
    "the pre-`add` worktree diff must be EMPTY for this fixture — that emptiness is the bug, and " +
    "a fixture without it cannot detect the fix");

  const changed = runStageAndList(repo);
  const { body } = prContent({ local: "", canonical: "2.0.0", files: changed });

  assert.doesNotMatch(body, /version stamp only/,
    "a body whose diff adds three files must not carry a sentence saying no infra files differed " +
    "— that is not an omission a reviewer can notice, it is a sentence telling them not to look");
  for (const path of [".flow/VERSION", ".flow/bin/flow-doctor.mjs", ".github/workflows/flow-compass.yml"]) {
    assert.ok(body.includes(`- \`${path}\``), `the body must list ${path}. Got:\n${body}`);
  }
  assert.match(body, /\*\*Added\*\* \(3\)/,
    "and must say how many, so a list short of the diff is visible as a count rather than as an " +
    "absence the reader has to notice");
});

// ── the shape observed live: a plausible list that is not the diff ──

test("a sync that adds, modifies and deletes reports all three, distinguishably", { skip: skipReusable }, (t) => {
  const repo = fixtureRepo(t, {
    ".flow/VERSION": "1.0.0\n",
    ".flow/bin/flow-doctor.mjs": "// old\n",
    ".flow/bin/retired.mjs": "// canonical deleted this\n",
  });

  write(repo, ".flow/VERSION", "2.0.0\n");                               // modified
  write(repo, ".flow/bin/flow-doctor.mjs", "// new\n");                  // modified
  rmSync(join(repo, ".flow/bin/retired.mjs"));                           // deleted (rsync --delete)
  write(repo, ".github/workflows/flow-compass.yml", "name: flow-compass\n"); // added

  const { body } = prContent({ local: "1.0.0", canonical: "2.0.0", files: runStageAndList(repo) });

  const at = (needle) => body.indexOf(needle);
  assert.ok(at("**Added** (1)") >= 0 && at("**Modified** (2)") >= 0 && at("**Removed** (1)") >= 0,
    `all three classes must be headed and counted. Got:\n${body}`);
  assert.ok(at("**Added**") < at("- `.github/workflows/flow-compass.yml`"),
    "the added workflow must be listed under Added");
  assert.ok(at("- `.github/workflows/flow-compass.yml`") < at("**Modified**"),
    "…and not flattened in with the modified files — an added file that will execute in this " +
    "repo's CI is a different review question from a changed one. This is TanPlan#26: a body " +
    "that listed the 22 modified files and none of the 15 added ones read as complete");
  assert.ok(at("**Removed**") < at("- `.flow/bin/retired.mjs`"),
    "and a file canonical deleted must be visible as a deletion");
});

// ── the one case where the sentence is true ──

test("a genuine stamp-only sync still says 'version stamp only — no infra files differed'", { skip: skipReusable }, (t) => {
  const repo = fixtureRepo(t, {
    ".flow/VERSION": "1.0.0\n",
    ".flow/bin/flow-doctor.mjs": "// unchanged\n",
  });

  write(repo, ".flow/VERSION", "2.0.0\n"); // the stamp advances; nothing else differs

  const changed = runStageAndList(repo);
  assert.equal(changed.trim(), "M\t.flow/VERSION",
    "the staged tree for a stamp-only sync is the stamp alone — if this changes, the assertion " +
    "below is testing something else");

  const { body } = prContent({ local: "1.0.0", canonical: "2.0.0", files: changed });
  assert.match(body, /version stamp only — no infra files differed/,
    "the sentence is CORRECT here and must survive the fix. Deleting it to make the bug go away " +
    "would trade a false statement for a blank section — still no way for a reviewer to tell a " +
    "stamp bump from a sync whose list failed to render");
});

// ── the thin caller owns none of this ──

test("the thin caller carries no file-list computation — the ordering lives only in the reusable", { skip: skipCaller }, () => {
  const caller = readFileSync(CALLER, "utf8");
  assert.doesNotMatch(caller, /^\s*run:/m,
    "flow-sync.yml is a pure `uses:` caller: schedule, permissions, secrets, nothing executable. " +
    "If it ever grows a `run:` step, the flow-0054 ordering may have been duplicated into it and " +
    "this test is the reminder to fix both");
  assert.doesNotMatch(caller, /CHANGED|--name-only|--name-status/,
    "and it must not compute the synced-file list — that list is built in _flow-sync.yml, so an " +
    "adopting repo pinned at @v2 picks the fix up with no edit to its own caller");
  assert.match(caller, /uses:\s*CandidDan\/flow\/\.github\/workflows\/_flow-sync\.yml@/,
    "…which is only true while it still delegates to the reusable");
});

// ── parsing, at the unit ──

test("parseChanges splits --name-status into a class and a path", () => {
  assert.deepEqual(parseChanges("A\t.flow/bin/new.mjs\nM\t.flow/VERSION\nD\t.flow/bin/gone.mjs"), [
    { status: "A", path: ".flow/bin/new.mjs" },
    { status: "M", path: ".flow/VERSION" },
    { status: "D", path: ".flow/bin/gone.mjs" },
  ]);
});

test("parseChanges takes the destination path of a rename, never 'old\\tnew' as one path", () => {
  // `--no-renames` means the workflow never sends one, but `pr-body` is callable by hand.
  assert.deepEqual(parseChanges(["R100\t.flow/bin/old.mjs\t.flow/bin/new.mjs"]), [
    { status: "R100", path: ".flow/bin/new.mjs" },
  ]);
});

test("parseChanges reports a bare path as class-unknown rather than guessing", () => {
  assert.deepEqual(parseChanges([".flow/VERSION", "", "  "]), [{ status: null, path: ".flow/VERSION" }]);
});

test("prContent lists a class it cannot name under 'Changed', claiming nothing about it", () => {
  const { body } = prContent({
    local: "1.0.0", canonical: "2.0.0",
    files: "T\t.flow/bin/link.mjs\n.flow/bin/legacy.mjs",
  });
  assert.match(body, /\*\*Changed\*\* \(2\)/);
  assert.ok(body.includes("- `.flow/bin/link.mjs`") && body.includes("- `.flow/bin/legacy.mjs`"));
  assert.doesNotMatch(body, /\*\*Added\*\*|\*\*Modified\*\*|\*\*Removed\*\*/,
    "an unrecognised status must not be filed under a class it was never reported as");
});

test("prContent: the stamp alone is stamp-only; the stamp alongside anything else is listed", () => {
  // The exclusion that makes the true case reachable at all: `_flow-sync.yml` rewrites
  // `.flow/VERSION` on every sync, so the staged tree is never empty and an emptiness test alone
  // could never fire. The stamp is still LISTED whenever anything else moved.
  assert.match(prContent({ local: "1.0.0", canonical: "2.0.0", files: "M\t.flow/VERSION" }).body,
    /version stamp only/);
  const mixed = prContent({
    local: "1.0.0", canonical: "2.0.0",
    files: "M\t.flow/VERSION\nA\t.github/workflows/flow-compass.yml",
  }).body;
  assert.doesNotMatch(mixed, /version stamp only/);
  assert.ok(mixed.includes("- `.flow/VERSION`"),
    "the stamp is excluded from the DECISION, not from the list");
});

// ── the customised-caller guard (flow-0076) ──
//
// The sync's caller-copy loop was a bare `cp` over the local file, so a repo that had added jobs to
// its own caller lost them on every sync with nothing said. These are the proving tests for the rule
// that stops it: a caller is kept when it declares a top-level job key the incoming template does
// not. Fixtures are written as real workflow text — the scan is a line scan, so its input shape
// (indentation, comments, block scalars) is the thing under test and a synthetic object would prove
// nothing about it.

// FIXTURE OWNER. The `uses:` owner is the placeholder `OWNER/flow` rather than canonical's real
// owner/repo, and deliberately so: `docs/adr/` carries a rename-cutover amendment whose count of
// files naming that reference is pinned to the working tree by `adr-split-authoring.test.mjs`, so a
// new file spelling it out fails that test — and the ADR is not this task's to edit. Nothing here
// parses the value anyway; only the job KEYS are under test.
const CANON_GATES = `name: flow-gates
on:
  pull_request:

jobs:
  gate:
    uses: OWNER/flow/.github/workflows/_flow-gates.yml@v2
    with:
      node_version: "22"
    secrets:
      FLOW_PAT: \${{ secrets.FLOW_PAT }}
`;

// Nudge's real shape: the thin job canonical ships, plus three per-tree checks the reusable cannot
// express. `edge-parse` is the CAN-32 guard whose absence surfaced as a production BOOT_ERROR.
const NUDGE_GATES = `name: flow-gates
on:
  pull_request:

jobs:
  gate:
    uses: OWNER/flow/.github/workflows/_flow-gates.yml@v2
    with:
      node_version: "20"

  edge-parse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: deno check supabase/functions/**/*.ts

  mcp-build:
    runs-on: ubuntu-latest
    steps:
      - run: npm --prefix mcp run build
`;

test("extraJobs names the jobs a copy would delete (criterion 1)", () => {
  assert.deepEqual(extraJobs(NUDGE_GATES, CANON_GATES), ["edge-parse", "mcp-build"]);
});

test("extraJobs reports nothing when only the pin or a job's contents differ (criterion 2)", () => {
  // The same job set, a different `uses:` pin and a different `with:` input. This is the common
  // case — most callers canonical changes look like this — and it must still be overwritten,
  // or the guard would freeze the whole fleet's callers at whatever version they adopted.
  const localPinned = CANON_GATES
    .replace("_flow-gates.yml@v2", "_flow-gates.yml@v1.4.0")
    .replace('node_version: "22"', 'node_version: "20"');
  assert.notEqual(localPinned, CANON_GATES, "the fixture must actually differ in text");
  assert.deepEqual(extraJobs(localPinned, CANON_GATES), []);
  assert.deepEqual(extraJobs(CANON_GATES, CANON_GATES), []);
});

test("only top-level job keys count: comments, blank lines and nested keys (criterion 3)", () => {
  const local = `name: flow-gates
on:
  pull_request:

jobs:

  # canonical's thin job — do not edit, it is replaced on every sync
  gate:
    uses: OWNER/flow/.github/workflows/_flow-gates.yml@v2
    with:
      node_version: "22"
    # a comment at a job's own depth

  # ── this repo's own checks ──────────────────────────────────────────
  edge-parse:
    runs-on: ubuntu-latest
    env:
      gate: "a nested key that reuses a job name"
    steps:
      - name: parse
        run: |
          jobs:
            gate:
          deno check supabase/functions/**/*.ts

concurrency:
  group: flow-gates-\${{ github.ref }}
`;
  // `steps:`, `with:`, `env:` and the `jobs:`/`gate:` lines inside the block scalar are all deeper
  // than a job key and are not compared; `concurrency:` is back in column 0 and ends the block.
  assert.deepEqual(topLevelJobKeys(local), ["gate", "edge-parse"]);
  assert.deepEqual(extraJobs(local, CANON_GATES), ["edge-parse"]);
});

test("a CRLF-encoded caller still reports its extra jobs", () => {
  // A caller hand-edited on Windows. Reading `jobs:\r` as not-`jobs:` returns [], which the copy
  // loop takes as "safe to overwrite" — the silent deletion this guard exists to stop.
  const crlf = NUDGE_GATES.replace(/\n/g, "\r\n");
  assert.ok(crlf.includes("jobs:\r\n"), "the fixture must actually be CRLF");
  assert.deepEqual(topLevelJobKeys(crlf), ["gate", "edge-parse", "mcp-build"]);
  assert.deepEqual(extraJobs(crlf, CANON_GATES), ["edge-parse", "mcp-build"]);
  // Either side may be the CRLF one; a CRLF incoming template must not hide its own `gate`.
  assert.deepEqual(extraJobs(NUDGE_GATES, CANON_GATES.replace(/\n/g, "\r\n")), ["edge-parse", "mcp-build"]);
});

test("topLevelJobKeys reads the job indent off the file rather than assuming two spaces", () => {
  // A scan that fails must fail towards reporting MORE jobs, never fewer — "no extra jobs" is the
  // answer that lets the copy proceed and delete them.
  const fourSpace = "name: x\njobs:\n    gate:\n        uses: a\n    edge-parse:\n        runs-on: ubuntu-latest\n";
  assert.deepEqual(topLevelJobKeys(fourSpace), ["gate", "edge-parse"]);
});

test("topLevelJobKeys ignores a `jobs:` that is not a top-level key, and a file with none", () => {
  assert.deepEqual(topLevelJobKeys("name: x\non:\n  push:\n"), []);
  assert.deepEqual(topLevelJobKeys(""), []);
  assert.deepEqual(topLevelJobKeys(undefined), []);
  // A `jobs:` nested under something else is not the workflow's job map.
  assert.deepEqual(topLevelJobKeys("on:\n  workflow_call:\njobs2:\n  gate:\n"), []);
});

test("topLevelJobKeys does not mistake a key that has a value for a job id", () => {
  // Job ids are mapping keys, so nothing but a comment may follow the colon. Without that anchor a
  // one-line `gate: {}` — or any scalar at job depth — would be counted, and the guard would keep
  // callers it should overwrite.
  assert.deepEqual(topLevelJobKeys("jobs:\n  gate:   # canonical's\n    uses: a\n"), ["gate"]);
  assert.deepEqual(topLevelJobKeys("jobs:\n  gate: not-a-job\n"), []);
});

// ── parseKept + the PR-body section ──

test("parseKept reads `<path>\\t<jobs>` lines and drops blanks", () => {
  assert.deepEqual(
    parseKept(".github/workflows/flow-gates.yml\tedge-parse mcp-build\n\n.github/workflows/flow-compass.yml\tnightly"),
    [
      { path: ".github/workflows/flow-gates.yml", jobs: ["edge-parse", "mcp-build"] },
      { path: ".github/workflows/flow-compass.yml", jobs: ["nightly"] },
    ]);
  assert.deepEqual(parseKept(""), []);
  assert.deepEqual(parseKept(), []);
});

test("prContent renders a 'Kept: customised callers' section naming the jobs (criterion 5)", () => {
  const { body } = prContent({
    local: "1.3.0", canonical: "2.0.0",
    files: "M\t.flow/VERSION\nM\t.flow/bin/flow-doctor.mjs",
    kept: ".github/workflows/flow-gates.yml\tedge-parse mcp-build",
  });
  const kept = body.split("### Kept: customised callers")[1];
  assert.ok(kept, "the section must be present when a caller was kept");
  assert.match(kept, /- `\.github\/workflows\/flow-gates\.yml` — extra jobs: `edge-parse`, `mcp-build`/);
  assert.match(kept, /would have \*\*deleted\*\*/,
    "the section must say what the alternative was, or it reads as a routine omission");
  assert.match(kept, /does \*\*not\*\*\n?\s*receive this version's changes/,
    "…and that the kept file is now behind, which is the cost the reviewer is accepting");
  // The kept caller is NOT in the synced list — it was not copied — so the two sections cannot
  // contradict each other.
  assert.ok(!body.split("### Kept")[0].includes("flow-gates.yml"));
});

test("prContent omits the kept section entirely when nothing was kept", () => {
  const { body } = prContent({ local: "1.3.0", canonical: "2.0.0", files: "M\t.flow/VERSION" });
  assert.doesNotMatch(body, /Kept: customised callers/,
    "a 'Kept: none' line on every sync PR is boilerplate, and this section has to be read the one " +
    "time it appears");
  assert.doesNotMatch(prContent({
    local: "1.3.0", canonical: "2.0.0", files: "M\t.flow/VERSION", kept: "",
  }).body, /Kept: customised callers/);
});
