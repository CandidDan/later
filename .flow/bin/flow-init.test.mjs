// flow-init.test.mjs — proving tests for flow-0005, one per acceptance criterion.
//
// HERMETIC BY CONSTRUCTION. Adoption's inputs are a canonical checkout and an empty repo, so
// every test builds both in a temp directory. Nothing here touches the network: the tool's only
// network path is `resolveCanonical` without `--from`, and every run below passes `--from`.
//
// THE FIXTURE IS THE REAL TREE, NOT A MOCK. `<this dir>/..` is `.flow/`, and its parent is the
// template root in BOTH contexts this file runs in — `project-template/` in canonical, the repo
// root in a repo that adopted Flow. So the fixture canonical checkout is assembled from the real
// `.flow/bin`, the real `.claude/` and the real `flow-*.yml` callers. That matters for two
// criteria in particular: the caller COUNT is whatever canonical actually ships (a hardcoded
// number is how INIT.md came to claim six when there were nine), and the re-pin runs against real
// caller text rather than a stub that happens to match the regex.
//
// THE FIXTURE OWNS WHAT IT ASSERTS ON (flow-0078). The corollary of that second context is the
// rule this file has to obey: it may only assert things that are true in EVERY repo it is copied
// into. Anything the assertions pin down by content, the fixture therefore writes itself rather
// than sourcing from the tree around it:
//
//   * `.flow/tasks/` — only `_TEMPLATE.md` and one sample, so `flow-doctor`'s verdict on an
//     initialised repo is a fact about flow-init and not about whichever tasks this repo holds.
//   * `.flow/board.html` — the template's shape reduced to the two lines flow-init rewrites.
//     Downstream, `<.flow>/board.html` is the ADOPTING repo's live board: already pointed at its
//     own repo, holding its own tasks, and — if it predates the `const REPO` placeholder — with
//     nothing for `prepareBoard` to rewrite at all. Asserting on that board tested the adopter.
//     Writing it here also keeps this file out of flow-0022's blast radius.
//   * `CLAUDE.md` / `AGENTS.md` — downstream these are the adopter's own host files, and a repo
//     part-way through a 1.x→2.x sync has no `AGENTS.md` yet, so "both host files ship" was a
//     claim about the adopter rather than about flow-init. That the REAL template ships both is
//     asserted in canonical by `.flow/bin/protocol-portability.test.mjs`, where it belongs.
//
// That rule is enforced rather than remembered: canonical's `.flow/bin/flow-init-downstream.test.mjs`
// runs this file from a synthetic adopter layout and fails if it goes red there.
//
// NO DEPENDENCIES. flow-gates' `flow-tooling` job runs `node --test .flow/bin/*.test.mjs` with no
// `npm ci` in front of it, so an import of `yaml` or `c8` here would die before a single test ran.
// The YAML assertions below are line scans for that reason — the same scan flow-doctor uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_CANONICAL_REPO, buildPlan, classify, loadInputs, mergeGitignore, parseArgs,
  parseSourceRootFlag, prepareBoard, refFromVersion, renderConfig, renderUsage, repin,
  resolveCanonical, resolveDefaultRef, runInit, validateInputs, versionStamps,
} from "./flow-init.mjs";

const BIN = import.meta.dirname;
const FLOW = resolve(BIN, "..");
const TEMPLATE_ROOT = resolve(FLOW, "..");   // project-template/ in canonical; repo root downstream
const CLI = join(BIN, "flow-init.mjs");

const temp = (name) => mkdtempSync(join(tmpdir(), `flow-init-${name}-`));

// A canonical checkout: <root>/VERSION + <root>/project-template/{.flow,.claude,.github,…}.
function canonicalFixture() {
  const root = temp("canon");
  const tpl = join(root, "project-template");
  writeFileSync(join(root, "VERSION"), "9.9.9\n");

  mkdirSync(join(tpl, ".flow", "tasks"), { recursive: true });
  cpSync(join(FLOW, "bin"), join(tpl, ".flow", "bin"), { recursive: true });
  writeFileSync(join(tpl, ".flow", "config.yml"),
    'project:\n  name: "REPLACE-ME"\ncommands:\n  install: "REPLACE-ME"\n');
  writeFileSync(join(tpl, ".flow", "VERSION"), "0.0.0\n");
  writeFileSync(join(tpl, ".flow", "tasks", "_TEMPLATE.md"), TEMPLATE_TASK);
  writeFileSync(join(tpl, ".flow", "tasks", "0001-sample.md"), SAMPLE_TASK);
  writeFileSync(join(tpl, ".flow", "board.html"), SAMPLE_BOARD);
  cpSync(join(FLOW, "PROTOCOL.md"), join(tpl, ".flow", "PROTOCOL.md"));

  cpSync(join(TEMPLATE_ROOT, ".claude"), join(tpl, ".claude"), { recursive: true });

  mkdirSync(join(tpl, ".github", "workflows"), { recursive: true });
  const wfSrc = join(TEMPLATE_ROOT, ".github", "workflows");
  for (const name of readdirSync(wfSrc).filter((n) => /^flow-.+\.ya?ml$/.test(n)))
    cpSync(join(wfSrc, name), join(tpl, ".github", "workflows", name));

  // The two host files are the fixture's own, not the surrounding tree's — see the header note.
  writeFileSync(join(tpl, "CLAUDE.md"), HOST_FILE("Claude Code"));
  writeFileSync(join(tpl, "AGENTS.md"), HOST_FILE("agents following the AGENTS.md convention"));

  for (const name of [".gitattributes", ".gitignore"])
    if (existsSync(join(TEMPLATE_ROOT, name))) cpSync(join(TEMPLATE_ROOT, name), join(tpl, name));

  // Canonical's own adoption documentation, plus a file it has not invented yet. Which root files
  // travel is decided by subtraction, so both cases have to be pinned.
  for (const name of ["README.md", "INIT.md", "RETROFIT.md", "FLOW-handoff.html", "VISION.md"])
    writeFileSync(join(tpl, name), `canonical doc: ${name}\n`);
  writeFileSync(join(tpl, "NEW-THING.md"), "a root file canonical added after flow-init was written\n");

  return root;
}

const TEMPLATE_TASK = '---\nid: "PROJ-0000"\ntitle: "<title>"\nstatus: "ready"\npriority: 2\n---\n\n## Context\n';
const SAMPLE_TASK = [
  '---', 'id: "PROJ-0001"', 'title: "Sample task shipped with the template"', 'status: "ready"',
  'priority: 2', 'touches: ["src/**"]', '---', '', '## Context', 'x', '', '## Scope', 'x', '',
  '## Acceptance criteria', '', '- [ ] Given x, when y, then z.', '',
].join("\n");

// The template's board, reduced to exactly the two declarations `prepareBoard` rewrites: the
// unset `REPO` placeholder it points at the adopting repo, and a `TASKS` snapshot holding the
// sample task it has to empty. Both are written at line start because both of prepareBoard's
// patterns are anchored — a board whose placeholder is indented, quoted differently or simply
// absent is silently left alone, which is the downstream failure flow-0078 fixed.
const SAMPLE_BOARD = [
  "<!doctype html>", "<title>Flow board</title>", "<script>",
  'const REPO = "";',
  "const TASKS = [",
  '  { id: "PROJ-0001", title: "Sample task shipped with the template", status: "ready" },',
  "];",
  "</script>", "",
].join("\n");

// A host file's content is not what any assertion here checks — only that flow-init copied it —
// so the fixture's copy says what it is and points at the one protocol, like the real ones do.
const HOST_FILE = (who) =>
  `# Flow — host file for ${who}\n\nThe protocol lives in one place:\n\n@.flow/PROTOCOL.md\n`;

// An empty-ish target repo holding the one source tree the inputs will declare.
function targetFixture() {
  const dir = temp("target");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.js"), "export const x = 1;\n");
  return dir;
}

const INPUT_FLAGS = [
  "--name", "acme", "--language", "javascript", "--description", "Acme's storefront.",
  "--repo", "acme-co/storefront",
  "--install", "npm ci", "--build", "npm run build", "--lint", "npm run lint",
  "--test", "npm test", "--coverage", "npm run coverage",
  "--coverage-min", "81.5",
  "--source-root", "src/=npm run lint",
];

// Run the CLI the way a caller would, and capture everything a caller could branch on.
function init(target, canonical, extra = []) {
  const r = spawnSync(process.execPath,
    [CLI, ...INPUT_FLAGS, "--from", canonical, "--target", target, ...extra],
    { encoding: "utf8", stdio: "pipe" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Byte-level snapshot of a tree: path -> sha256. "Unchanged" means unchanged, not "looks the same".
function snapshot(dir, base = dir, acc = new Map()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) snapshot(p, base, acc);
    else if (e.isFile()) acc.set(p.slice(base.length), createHash("sha256").update(readFileSync(p)).digest("hex"));
  }
  return acc;
}
const sameTree = (a, b) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// The ref a no-`--canonical-ref` run must resolve to, computed from the fixture canonical's own
// stamp. NEVER a literal: `v2` written here would pass today and stop meaning anything the moment
// 3.0.0 is cut, which is precisely how `DEFAULT_CANONICAL_REF = "v1"` survived the 2.0.0 re-cut
// and put flow-0058 in the backlog. Same derivation as `.flow/bin/caller-pins.test.mjs`.
const refOfFixture = (canonicalRoot) =>
  `v${readFileSync(join(canonicalRoot, "VERSION"), "utf8").trim().split(".")[0]}`;

const callerFiles = (target) =>
  readdirSync(join(target, ".github", "workflows")).filter((n) => /^flow-.+\.ya?ml$/.test(n)).sort();
const usesLines = (target) =>
  callerFiles(target).flatMap((n) =>
    readFileSync(join(target, ".github", "workflows", n), "utf8")
      .split("\n").filter((l) => /^\s*uses:/.test(l)).map((l) => l.trim()));

// ── criterion 1 ────────────────────────────────────────────────────────────────────────
test("a complete input set initialises an empty repo: every caller, .flow/, .claude/, no REPLACE-ME", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const expected = readdirSync(join(canonical, "project-template", ".github", "workflows"))
    .filter((n) => /^flow-.+\.ya?ml$/.test(n)).sort();

  const r = init(target, canonical);
  assert.equal(r.code, 0, r.err);

  assert.deepEqual(callerFiles(target), expected,
    "a short copy of the callers is a silent hole in the gate — the count comes from canonical, never a literal");
  assert.ok(expected.length >= 9, `canonical should ship at least the nine callers, saw ${expected.length}`);
  assert.ok(existsSync(join(target, ".flow", "bin", "flow-doctor.mjs")), ".flow/ must arrive");
  assert.ok(existsSync(join(target, ".claude", "settings.json")), ".claude/ must arrive");
  assert.ok(existsSync(join(target, ".flow", "PROTOCOL.md")), "the protocol travels inside .flow/");
  assert.ok(existsSync(join(target, "CLAUDE.md")) && existsSync(join(target, "AGENTS.md")),
    "both host files ship: dropping one strands whichever agent follows that convention");
  assert.ok(existsSync(join(target, ".gitattributes")), ".gitattributes travels with the template");
  assert.ok(existsSync(join(target, "NEW-THING.md")),
    "root files travel by SUBTRACTION: a file canonical adds later must ship without anyone " +
    "editing a list of names here — the same rule as the caller count");
  for (const doc of ["README.md", "INIT.md", "RETROFIT.md", "FLOW-handoff.html"])
    assert.ok(!existsSync(join(target, doc)),
      `${doc} is canonical's own documentation — copying it into an adopted repo hands its readers ` +
      "a runbook for a step they have already taken");

  const cfg = readFileSync(join(target, ".flow", "config.yml"), "utf8");
  assert.ok(!cfg.includes("REPLACE-ME"),
    "a REPLACE-ME left in config.yml is a gate that runs a placeholder command");
  assert.match(cfg, /^\s*name: "acme"(\s|$)/m);
  assert.match(cfg, /^\s*test:\s+"npm test"$/m);
  assert.match(cfg, /^coverage_min: 81.5$/m);
  assert.match(cfg, /^\s*- path: "src\/"$/m);
  assert.equal(readFileSync(join(target, ".flow", "VERSION"), "utf8").trim(), "9.9.9",
    "the stamp comes from the canonical checkout's VERSION, not from the template's own copy");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── criterion 2 ────────────────────────────────────────────────────────────────────────
test("an input set missing the coverage command exits non-zero naming it, and writes nothing", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const before = snapshot(target);
  const flags = INPUT_FLAGS.filter((f, i) =>
    f !== "--coverage" && INPUT_FLAGS[i - 1] !== "--coverage");

  const r = spawnSync(process.execPath,
    [CLI, ...flags, "--from", canonical, "--target", target], { encoding: "utf8", stdio: "pipe" });

  assert.equal(r.status, 1, "a missing command must fail loudly, not default to something plausible");
  assert.match(r.stderr, /commands\.coverage is required/,
    "the failure has to name the field — 'invalid input' sends the caller hunting");
  assert.ok(sameTree(before, snapshot(target)), "a rejected run must not leave a half-initialised repo");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("every required input is required — each omission is reported by name in one pass", () => {
  const errors = validateInputs({
    project: { name: "", language: "", description: "" },
    repo: "", commands: { install: "", build: "", lint: "", test: "", coverage: "" },
    coverage_min: "", source_roots: [], security: { focus: [] },
    canonical: { repo: DEFAULT_CANONICAL_REPO, ref: "v1" },
  }, { targetDir: "" });

  for (const field of ["project.name", "project.language", "project.description", "repo",
    "commands.install", "commands.build", "commands.lint", "commands.test", "commands.coverage",
    "coverage_min", "source_roots"]) {
    assert.ok(errors.some((e) => e.startsWith(field) || e.includes(field)), `missing ${field} unreported`);
  }
});

// ── criterion 3 ────────────────────────────────────────────────────────────────────────
test("a canonical ref of v1-edge pins every caller AND the flow-sync caller's canonical_ref", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const r = init(target, canonical, ["--canonical-ref", "v1-edge"]);
  assert.equal(r.code, 0, r.err);

  const lines = usesLines(target);
  assert.ok(lines.length > 0, "an empty check is a failure, not a pass");
  for (const l of lines) assert.match(l, /@v1-edge$/, `caller still on the old pin: ${l}`);

  const sync = readFileSync(join(target, ".github", "workflows", "flow-sync.yml"), "utf8");
  assert.match(sync, /canonical_ref: \$\{\{ inputs\.canonical_ref \|\| 'v1-edge' \}\}/,
    "THE SPLIT-BRAIN TRAP: _flow-sync defaults canonical_ref to 'v1' independently of the callers' " +
    "pin, so an edge-pinned repo would run edge workflows while syncing stable tooling — quietly, " +
    "because both halves work and only disagree about which release this repo is on");
  assert.doesNotMatch(sync, /Default v1\.\"/,
    "the dispatch input's advertised default must not still say v1 on an edge repo");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── criterion 4 ────────────────────────────────────────────────────────────────────────
test("a non-default canonical repo is named by every uses: line, and the default by none", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const r = init(target, canonical, ["--canonical-repo", "acme-co/flow"]);
  assert.equal(r.code, 0, r.err);

  // No --canonical-ref here, so the ref is the DERIVED default (flow-0058): a non-default repo
  // must not quietly drag the ref back to a literal either.
  const ref = refOfFixture(canonical);
  const lines = usesLines(target);
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.match(l, new RegExp(`uses: acme-co/flow/\\.github/workflows/_flow-[a-z-]+\\.yml@${ref}$`), l);
    assert.doesNotMatch(l, new RegExp(DEFAULT_CANONICAL_REPO.replace("/", "\\/")),
      "a caller left pointing at the default resolves to 'workflow not found' across owners — " +
      "the confusing failure INIT.md warns about");
  }
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("repin leaves third-party uses: pins alone", () => {
  const text = [
    "jobs:", "  x:", "    uses: CandidDan/flow/.github/workflows/_flow-gates.yml@v1",
    "    steps:", "      - uses: actions/checkout@v4", "",
  ].join("\n");
  const out = repin(text, { repo: "acme-co/flow", ref: "v2" });
  assert.match(out, /uses: acme-co\/flow\/\.github\/workflows\/_flow-gates\.yml@v2/);
  assert.match(out, /uses: actions\/checkout@v4/, "only the _flow-* reusables belong to canonical");
});

// ── criterion 5 ────────────────────────────────────────────────────────────────────────
test("--dry-run prints the planned writes and leaves the repo byte-identical", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const before = snapshot(target);

  const r = init(target, canonical, ["--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /plan \(dry run\)/);
  assert.match(r.out, /create\s+\.flow\/config\.yml/, "the plan must list the files, not just count them");
  assert.match(r.out, /create\s+\.github\/workflows\/flow-gates\.yml/);
  assert.match(r.out, /Nothing written \(--dry-run\)/);
  assert.ok(sameTree(before, snapshot(target)), "--dry-run wrote something");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── criterion 6 ────────────────────────────────────────────────────────────────────────
test("an already-initialised repo reports the differences and changes nothing without --force", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  assert.equal(init(target, canonical).code, 0);

  // The realistic collision: someone re-runs adoption pointing at a different channel.
  const before = snapshot(target);
  const r = init(target, canonical, ["--canonical-ref", "v1-edge"]);

  assert.equal(r.code, 3, "an initialised repo must not be silently overwritten");
  assert.match(r.err, /already differ from this plan — nothing written/);
  assert.match(r.err, /flow-gates\.yml differs/, "the report has to name the files that differ");
  assert.ok(sameTree(before, snapshot(target)), "a refused run must change nothing at all");

  // --force is the authorisation, and it is the only thing that changes the answer.
  const forced = init(target, canonical, ["--canonical-ref", "v1-edge", "--force"]);
  assert.equal(forced.code, 0, forced.err);
  for (const l of usesLines(target)) assert.match(l, /@v1-edge$/);
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("re-running with the same inputs is a no-op: nothing differs, nothing is rewritten", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  assert.equal(init(target, canonical).code, 0);
  const after = snapshot(target);

  const again = init(target, canonical);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already initialised at this ref and byte-identical/);
  assert.ok(sameTree(after, snapshot(target)),
    "idempotence is byte-level or it is nothing: a re-run that rewrites files makes every " +
    "subsequent diff a lie about what changed");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── criterion 7 ────────────────────────────────────────────────────────────────────────
test("flow-doctor reports no consistency failures against a freshly initialised repo", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  assert.equal(init(target, canonical).code, 0);

  const r = spawnSync(process.execPath, [join(target, ".flow", "bin", "flow-doctor.mjs")],
    { cwd: target, encoding: "utf8", stdio: "pipe" });

  assert.equal(r.status, 0,
    `flow-doctor failed on a repo flow-init just wrote — adoption that lands red hands the first ` +
    `task's author an involuntary CI-plumbing job:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /FAIL/, r.stderr);
  assert.match(r.stdout, /flow-doctor: \d+ task\(s\) checked/);
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── criterion 8 ────────────────────────────────────────────────────────────────────────
test("a source_root that does not exist in the target exits non-zero naming that path", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const before = snapshot(target);

  const flags = INPUT_FLAGS.map((f) => (f === "src/=npm run lint" ? "app/=npm run lint" : f));
  const r = spawnSync(process.execPath,
    [CLI, ...flags, "--from", canonical, "--target", target], { encoding: "utf8", stdio: "pipe" });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /source_root "app\/" does not exist in the target repo/,
    "a declared root that isn't there cannot be gated, and flow-doctor would fail the repo's own gate for it");
  assert.ok(sameTree(before, snapshot(target)), "nothing may be written when the inputs are wrong");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("a source_root that climbs out of the repo is refused, existence check or not", () => {
  // Found by review on PR #20. `join(target, "../src")` normalises to a directory OUTSIDE the
  // target, so the existence check alone would confirm a tree this repo does not contain — and
  // the same string then lands in config.yml, where every later flow-doctor run resolves it
  // against the repo root. `exists: () => true` here is deliberate: it proves the containment
  // rule is doing the work, not the filesystem happening to disagree.
  const base = {
    project: { name: "a", language: "b", description: "c" }, repo: "o/r",
    commands: Object.fromEntries(["install", "build", "lint", "test", "coverage"].map((k) => [k, "x"])),
    coverage_min: 80, security: { focus: [] }, canonical: { repo: "o/r", ref: "v1" },
  };
  for (const bad of ["../src/", "a/../../src/", "/etc/", "/tmp/x"]) {
    const errors = validateInputs({ ...base, source_roots: [{ path: bad, check: "x" }] },
      { targetDir: "/repo", exists: () => true });
    assert.ok(errors.some((e) => e.includes(bad) && /repo-relative path inside the target/.test(e)),
      `"${bad}" was accepted as a source root: ${JSON.stringify(errors)}`);
  }
  assert.deepEqual(validateInputs({ ...base, source_roots: [{ path: "src/", check: "x" }] },
    { targetDir: "/repo", exists: () => true }), [], "an ordinary relative root must still pass");
});

test("the CLI refuses an escaping source_root and writes nothing", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const before = snapshot(target);
  const flags = INPUT_FLAGS.map((f) => (f === "src/=npm run lint" ? "../src/=npm run lint" : f));

  const r = spawnSync(process.execPath,
    [CLI, ...flags, "--from", canonical, "--target", target], { encoding: "utf8", stdio: "pipe" });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a repo-relative path inside the target/);
  assert.ok(sameTree(before, snapshot(target)), "nothing may be written when the inputs are wrong");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── the deliberate omissions, and the merges ───────────────────────────────────────────
test("the template's sample task does not travel, and the board snapshot is emptied to match", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  assert.equal(init(target, canonical).code, 0);

  assert.deepEqual(readdirSync(join(target, ".flow", "tasks")), ["_TEMPLATE.md"],
    "the sample task is a reference for reading the template, not content: copied in it becomes a " +
    "genuinely dispatchable `ready` task pointing at files that do not exist");
  // Unconditional: the board under test is the one `canonicalFixture` wrote, so "no board here"
  // can no longer quietly turn these two assertions into a pass.
  const board = readFileSync(join(target, ".flow", "board.html"), "utf8");
  assert.doesNotMatch(board, /PROJ-0001/, "the board would otherwise disagree with the store on commit one");
  assert.match(board, /const REPO = "acme-co\/storefront";/,
    "the board must be re-pointed at the repo being initialised, not left on whatever it named before");
  assert.ok(!existsSync(join(target, "VISION.md")),
    "VISION.md ships as a shape with placeholder goals — a placeholder vision is worse than none");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("an existing .gitignore is merged, never clobbered", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  writeFileSync(join(target, ".gitignore"), "node_modules\n.env\n");

  assert.equal(init(target, canonical).code, 0);
  const merged = readFileSync(join(target, ".gitignore"), "utf8");
  assert.match(merged, /^\.env$/m, "replacing a repo's .gitignore silently un-ignores whatever it protected");
  assert.match(merged, /^\.flow\/board-edits\.json$/m, "the Flow lines still have to arrive");

  const again = init(target, canonical);
  assert.equal(again.code, 0, again.err);
  assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), merged,
    "a merge that appends on every run turns the second run into a diff");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("mergeGitignore adds only what is missing, and returns the file untouched when nothing is", () => {
  assert.equal(mergeGitignore(null, "a\nb\n"), "a\nb\n");
  assert.match(mergeGitignore("a\n", "a\nb\n"), /^a\n\n# --- Flow ---\nb\n$/);
  assert.equal(mergeGitignore("a\nb\n", "a\nb\n"), "a\nb\n");
  assert.equal(mergeGitignore("a\nb\n", "# only a comment\n"), "a\nb\n");
});

// ── inputs, refs and the things that must not be interpolated ──────────────────────────
test("a ref that is not a plain git ref is refused before it reaches YAML or a command line", () => {
  const errors = validateInputs({
    project: { name: "a", language: "b", description: "c" }, repo: "o/r",
    commands: Object.fromEntries(["install", "build", "lint", "test", "coverage"].map((k) => [k, "x"])),
    coverage_min: 80, source_roots: [{ path: "src/", check: "x" }], security: { focus: [] },
    canonical: { repo: "o/r", ref: "v1' }}\nmalicious: true" },
  }, { targetDir: "", exists: () => true });
  assert.ok(errors.some((e) => /not a plain git ref/.test(e)),
    "the ref lands inside single-quoted YAML and in `git clone --branch` argv — validate, don't escape");
});

test("unknown flags are an error, not a silent drop", () => {
  const { errors } = parseArgs(["--coverage-minimum", "80"]);
  assert.deepEqual(errors, ['unknown argument "--coverage-minimum"'],
    "a silently-dropped typo reports itself later as a missing field, which sends the caller to the wrong place");
});

test("flags override the --config file, and both shapes reach the same inputs", () => {
  const cfg = JSON.stringify({
    project: { name: "from-file", language: "python", description: "d" },
    repo: "o/r",
    commands: { install: "uv sync", build: "b", lint: "l", test: "pytest", coverage: "c" },
    coverage_min: 72, source_roots: [{ path: "pkg/", check: "ruff check ." }],
    security: { focus: ["row-level security policies"] },
    canonical: { repo: "o/flow", ref: "v2" },
  });
  const { inputs } = loadInputs(["--config", "x.json", "--name", "from-flag"], () => cfg);
  assert.equal(inputs.project.name, "from-flag");
  assert.equal(inputs.project.language, "python");
  assert.equal(inputs.commands.test, "pytest");
  assert.equal(inputs.coverage_min, 72);
  assert.deepEqual(inputs.source_roots, [{ path: "pkg/", check: "ruff check ." }]);
  assert.deepEqual(inputs.security.focus, ["row-level security policies"]);
  assert.equal(inputs.canonical.ref, "v2");
  assert.equal(inputs.security.defaulted, false);
});

test("an unreadable --config is reported, not swallowed", () => {
  const { errors } = loadInputs(["--config", "nope.json"], () => { throw new Error("ENOENT"); });
  assert.ok(errors.some((e) => e.includes("nope.json")));
});

test("source-root flags split on the first = so a check containing = survives", () => {
  assert.deepEqual(parseSourceRootFlag("app/=pytest --cov-fail-under=80"),
    { path: "app/", check: "pytest --cov-fail-under=80" });
  assert.deepEqual(parseSourceRootFlag("app/"), { path: "app/", check: "" });
});

test("omitted security.focus falls back to the shipped generic list, and the run says so", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const r = init(target, canonical);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /security\.focus not supplied/,
    "a default that arrives silently is indistinguishable from a value someone chose");
  assert.match(readFileSync(join(target, ".flow", "config.yml"), "utf8"), /authn\/authz boundaries/);
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("renderConfig quotes values that would otherwise break the file", () => {
  const cfg = renderConfig({
    project: { name: 'a"b', language: "js", description: "back\\slash" },
    repo: "o/r",
    commands: { install: "i", build: "b", lint: "l", test: 't --name="x"', coverage: "c" },
    coverage_min: 83.5, source_roots: [{ path: "src/", check: "l" }],
    security: { focus: ["x"] }, canonical: { repo: "o/r", ref: "v1" },
  });
  assert.match(cfg, /name: "a\\"b"/);
  assert.match(cfg, /description: "back\\\\slash"/);
  assert.match(cfg, /test:\s+"t --name=\\"x\\""/);
});

// ── the environment must be a canonical checkout ───────────────────────────────────────
test("a --from directory that is not a canonical checkout fails before writing anything", () => {
  const target = targetFixture();
  const notCanonical = temp("empty");
  const before = snapshot(target);
  const r = init(target, notCanonical);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a canonical Flow checkout/);
  assert.ok(sameTree(before, snapshot(target)));
  rmSync(notCanonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("a canonical checkout with no VERSION refuses to stamp one", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  rmSync(join(canonical, "VERSION"));
  const r = init(target, canonical);
  assert.equal(r.code, 1);
  assert.match(r.err, /no VERSION stamp/);
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("a template shipping no callers is refused — an empty copy is a failure, not a pass", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  rmSync(join(canonical, "project-template", ".github", "workflows"), { recursive: true, force: true });
  const r = init(target, canonical);
  assert.equal(r.code, 1);
  assert.match(r.err, /no flow-\*\.yml callers/);
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("resolveCanonical clones only when --from is absent, and never runs a shell", () => {
  const dir = temp("from");
  assert.equal(resolveCanonical({ from: dir, repo: "o/r", ref: "v1" }, () => {
    throw new Error("must not clone when --from is given");
  }), resolve(dir));

  let argv = null;
  resolveCanonical({ from: "", repo: "o/r", ref: "v1-edge" }, (cmd, args) => {
    argv = [cmd, ...args]; return { status: 0 };
  });
  assert.equal(argv[0], "git");
  assert.ok(argv.includes("--branch") && argv.includes("v1-edge"));
  assert.ok(argv.includes("https://github.com/o/r"));

  assert.throws(() => resolveCanonical({ from: "", repo: "o/r", ref: "v1" },
    () => ({ status: 128, stderr: "not found" })), /git clone o\/r@v1 failed/);
  assert.throws(() => resolveCanonical({ from: join(dir, "nope"), repo: "o/r", ref: "v1" }),
    /no such directory/);
  rmSync(dir, { recursive: true, force: true });
});

// ── plan mechanics ─────────────────────────────────────────────────────────────────────
test("the plan is deterministic: same checkout + same inputs -> identical bytes", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const inputs = loadInputs([...INPUT_FLAGS]).inputs;
  const a = buildPlan({ canonicalRoot: canonical, inputs, targetDir: target });
  const b = buildPlan({ canonicalRoot: canonical, inputs, targetDir: target });
  assert.deepEqual(a.files.map((f) => f.path), b.files.map((f) => f.path));
  for (const [i, f] of a.files.entries())
    assert.ok(f.contents.equals(b.files[i].contents), `${f.path} is not reproducible`);
  assert.equal(a.stamp, "9.9.9");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("classify separates create / differs / unchanged by bytes", () => {
  const dir = temp("classify");
  writeFileSync(join(dir, "same.txt"), "a");
  writeFileSync(join(dir, "other.txt"), "a");
  const files = [
    { path: "same.txt", contents: Buffer.from("a") },
    { path: "other.txt", contents: Buffer.from("b") },
    { path: "new.txt", contents: Buffer.from("c") },
  ];
  assert.deepEqual(classify(files, dir),
    { creates: ["new.txt"], differs: ["other.txt"], unchanged: ["same.txt"], merges: [] });

  // A merge-kind file that differs is an APPEND, not a collision: it must never demand --force.
  assert.deepEqual(classify([{ path: "other.txt", kind: "merge", contents: Buffer.from("b") }], dir),
    { creates: [], differs: [], unchanged: [], merges: ["other.txt"] });
  rmSync(dir, { recursive: true, force: true });
});

test("prepareBoard sets the repo and empties the snapshot", () => {
  const html = 'const TASKS = [\n  {id:"PROJ-0001", status:"ready"},\n];\nconst REPO = "";\n';
  const out = prepareBoard(html, "o/r");
  assert.match(out, /const REPO = "o\/r";/);
  assert.match(out, /const TASKS = \[\n\];/);
  assert.doesNotMatch(out, /PROJ-0001/);
});

test("--help prints usage, exits 0 and writes nothing", () => {
  const lines = [];
  assert.equal(runInit(["--help"], { log: (l) => lines.push(l), logErr: (l) => lines.push(l) }), 0);
  assert.match(lines.join("\n"), /flow-init — the mechanical half of Flow adoption/);
});

// ── flow-0058: the default canonical ref is DERIVED, not typed ─────────────────────────
//
// THE DEFECT. `DEFAULT_CANONICAL_REF = "v1"` survived the 2.0.0 re-cut. flow-0056 moved the ten
// published callers and `_flow-sync.yml`'s checkout to `@v2`; this third reference stayed, so a
// repo onboarded through `flow-init` with no `--canonical-ref` was BORN with `@v1` pins while its
// own `.flow/VERSION` said 2.0.0. Nothing reported it: a pin at a tag that still resolves is
// indistinguishable from a correct one.
//
// WHAT THESE PIN, AND WHY IT IS A DERIVATION. Every expectation below is computed from a VERSION
// stamp — the fixture's, or the tree this file lives in. A literal `v2` would pass today and stop
// meaning anything the moment 3.0.0 is cut, which is exactly how the tree arrived in the state
// flow-0058 fixes. The 3.0.0 case is the one that proves derivation rather than a relabelled
// constant: the same code, two canonicals, two different answers.

// ── criterion 1 ────────────────────────────────────────────────────────────────────────
test("with no --canonical-ref and no config, the ref is the major of canonical's root VERSION", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const expected = refOfFixture(canonical);

  const r = init(target, canonical);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`canonical\\s+${DEFAULT_CANONICAL_REPO}@${expected}\\b`),
    `the run must resolve the ref from the stamp it is about to copy, not from a literal:\n${r.out}`);
  assert.match(r.out, /--canonical-ref not supplied — derived @/,
    "a default that arrives silently is indistinguishable from a value someone chose");
  assert.match(r.out, new RegExp(`derived @${expected} from .*VERSION`),
    "the run has to name the stamp it derived from, or nobody can check it");

  // The stamp the pins were derived from is the stamp the repo receives. That agreement is the
  // whole point: the two halves of a release cannot disagree if one is computed from the other.
  assert.equal(readFileSync(join(target, ".flow", "VERSION"), "utf8").trim().split(".")[0],
    expected.slice(1), "pins and .flow/VERSION must name the same major");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

test("with no --from, the default comes from the stamp of the tree this flow-init lives in", () => {
  const canonicalRoot = resolve(BIN, "..", "..", "..");
  const { ref, stamp } = resolveDefaultRef();

  // Two contexts, and this file runs in both. In canonical it is
  // project-template/.flow/bin/flow-init.mjs, so root VERSION is the authority; in an adopted repo
  // it is .flow/bin/flow-init.mjs and .flow/VERSION records the canonical that repo adopted.
  const expectedStamp = existsSync(join(canonicalRoot, "project-template"))
    ? join(canonicalRoot, "VERSION")
    : join(FLOW, "VERSION");
  assert.equal(stamp, expectedStamp);
  assert.equal(ref, refFromVersion(readFileSync(expectedStamp, "utf8")));
  assert.match(ref, /^v\d+$/,
    "an unresolvable default must surface as a named failure, never as a silent v1");
});

// ── criterion 2 ────────────────────────────────────────────────────────────────────────
test("a canonical stamped 3.0.0 adopts @v3 — the case a relabelled constant cannot pass", () => {
  const three = canonicalFixture(), nine = canonicalFixture();
  writeFileSync(join(three, "VERSION"), "3.0.0\n");
  assert.notEqual(refOfFixture(three), refOfFixture(nine),
    "this case is only evidence if the two fixtures disagree");

  for (const [canonical, expected] of [[three, "v3"], [nine, refOfFixture(nine)]]) {
    const target = targetFixture();
    const r = init(target, canonical);
    assert.equal(r.code, 0, r.err);
    const lines = usesLines(target);
    assert.ok(lines.length > 0, "an empty check is a failure, not a pass");
    for (const l of lines)
      assert.match(l, new RegExp(`@${expected}$`),
        `the same code must answer ${expected} for this canonical — one constant cannot: ${l}`);
    rmSync(target, { recursive: true, force: true });
  }
  rmSync(three, { recursive: true, force: true }); rmSync(nine, { recursive: true, force: true });
});

test("refFromVersion reads the major, and refuses anything that is not one", () => {
  assert.equal(refFromVersion("2.0.0\n"), "v2");
  assert.equal(refFromVersion("  3.1.4 "), "v3");
  assert.equal(refFromVersion("10.0.0"), "v10", "a two-digit major is not a two-ref answer");
  assert.equal(refFromVersion("7"), "v7");
  for (const bad of ["v2.0.0", "2x.0.0", "", "   ", null, undefined, "next"])
    assert.equal(refFromVersion(bad), null, `${JSON.stringify(bad)} must not become a ref`);
});

// ── criterion 3 — precedence: flag → config → derived default, one run per level ────────
test("--canonical-ref wins over the config file, which wins over the derived default", () => {
  const canonical = canonicalFixture();
  const cfgDir = temp("cfg");
  const cfgPath = join(cfgDir, "init.json");
  writeFileSync(cfgPath, JSON.stringify({ canonical: { ref: "v1-edge" } }));

  const cases = [
    { name: "flag", extra: ["--config", cfgPath, "--canonical-ref", "v2-edge"], expect: "v2-edge" },
    { name: "config", extra: ["--config", cfgPath], expect: "v1-edge" },
    { name: "default", extra: [], expect: refOfFixture(canonical) },
  ];

  for (const c of cases) {
    const target = targetFixture();
    const r = init(target, canonical, c.extra);
    assert.equal(r.code, 0, `${c.name}: ${r.err}`);

    const lines = usesLines(target);
    assert.ok(lines.length > 0, "an empty check is a failure, not a pass");
    for (const l of lines)
      assert.match(l, new RegExp(`@${c.expect}$`), `${c.name} level did not win: ${l}`);

    // An explicit ref travels UNCHANGED — it is not re-derived, normalised or majored.
    const sync = readFileSync(join(target, ".github", "workflows", "flow-sync.yml"), "utf8");
    assert.match(sync, new RegExp(`canonical_ref: \\$\\{\\{ inputs\\.canonical_ref \\|\\| '${c.expect}' \\}\\}`),
      `${c.name}: the flow-sync caller's own fallback must carry the same ref, or the repo runs ` +
      `one release's workflows while syncing another's content`);

    // The derivation is skipped entirely when the caller named a ref, and the run says which.
    const derived = /--canonical-ref not supplied — derived @/.test(r.out);
    assert.equal(derived, c.name === "default", `${c.name}: wrong provenance reported`);
    rmSync(target, { recursive: true, force: true });
  }
  rmSync(canonical, { recursive: true, force: true }); rmSync(cfgDir, { recursive: true, force: true });
});

// ── criterion 4 ────────────────────────────────────────────────────────────────────────
test("--help advertises exactly the ref a real run resolves — neither can move without the other", () => {
  const lines = [];
  assert.equal(runInit(["--help"], { log: (l) => lines.push(l), logErr: (l) => lines.push(l) }), 0);
  const help = lines.join("\n");

  // The same resolution a real no-flag run performs, taken from the tool rather than retyped.
  const { inputs } = loadInputs([]);
  assert.match(inputs.canonical.ref, /^v\d+$/);

  assert.match(help, new RegExp(`default: ${DEFAULT_CANONICAL_REPO}@${inputs.canonical.ref}\\b`),
    `--help must advertise the resolved default:\n${help}`);
  assert.match(help, new RegExp(`"ref": "${inputs.canonical.ref}"`),
    "the copy-pasteable JSON example is where a stale ref gets re-introduced by hand");
  assert.doesNotMatch(help, /@v1\b/,
    "a --help still naming the previous major is how the pin this task removed came back");

  // The coupling, proved rather than asserted: renderUsage is a function OF the resolved ref, so
  // a different ref produces different text. A hard-coded default here could not do that.
  const other = renderUsage({ ref: "v99", stamp: "/fixture/VERSION" });
  assert.match(other, /default: CandidDan\/flow@v99, derived from \/fixture\/VERSION/);
  assert.match(other, /"ref": "v99"/);
  assert.doesNotMatch(other, new RegExp(`@${inputs.canonical.ref}\\b`));
});

// ── criterion 5 ────────────────────────────────────────────────────────────────────────
test("every generated flow-*.yml pins the ref flow-init resolved, end to end from the default", () => {
  const canonical = canonicalFixture(), target = targetFixture();
  const expected = refOfFixture(canonical);

  const r = init(target, canonical);
  assert.equal(r.code, 0, r.err);

  const callers = callerFiles(target);
  assert.ok(callers.length >= 9, `expected canonical's full caller set, saw ${callers.length}`);
  const lines = usesLines(target);
  assert.ok(lines.length >= callers.length, "an empty check is a failure, not a pass");
  for (const l of lines)
    assert.match(l, new RegExp(`^uses: ${DEFAULT_CANONICAL_REPO}/\\.github/workflows/_flow-[a-z-]+\\.yml@${expected}$`),
      `a caller left on another ref is a repo born on the wrong major: ${l}`);

  // Swept the other way round: NO reusable pin anywhere in the generated surface names a ref
  // other than the resolved one. The loop above proves the pins that exist are right; this proves
  // there is no survivor of a different major hiding in a file it did not visit.
  const strays = callers.flatMap((name) =>
    [...readFileSync(join(target, ".github", "workflows", name), "utf8")
      .matchAll(/_flow-[a-z-]+\.yml@(\S+)/g)]
      .filter((m) => m[1] !== expected)
      .map((m) => `${name}: @${m[1]}`));
  assert.deepEqual(strays, [], `a pin on another ref is a repo born on the wrong major: ${strays}`);
  assert.match(readFileSync(join(target, ".flow", "config.yml"), "utf8"),
    new RegExp(`Written by flow-init from ${DEFAULT_CANONICAL_REPO}@${expected}\\.`),
    "the config's own provenance line must name the ref the callers were pinned to");
  rmSync(canonical, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true });
});

// ── the promise the derivation must not break: flow-init invents nothing ───────────────
test("a ref that cannot be derived is a named failure, never an invented default", () => {
  const { inputs } = loadInputs([], undefined, { exists: () => false, read: () => "" });
  assert.equal(inputs.canonical.ref, "", "no stamp answered, so there is no ref to use");
  assert.equal(inputs.canonical.derivedFrom, "");

  const errors = validateInputs({
    project: { name: "a", language: "b", description: "c" }, repo: "o/r",
    commands: Object.fromEntries(["install", "build", "lint", "test", "coverage"].map((k) => [k, "x"])),
    coverage_min: 80, source_roots: [{ path: "src/", check: "x" }], security: { focus: [] },
    canonical: { repo: "o/r", ref: "" },
  }, { targetDir: "", exists: () => true });

  assert.ok(errors.some((e) => e.startsWith("canonical.ref is required") && e.includes("--canonical-ref")),
    `an underivable ref must name the field and the remedy, not fall back to a literal: ` +
    JSON.stringify(errors));
});

test("the stamp lookup prefers --from, then canonical's root, then the adopted repo's .flow", () => {
  const moduleDir = "/x/project-template/.flow/bin";

  assert.deepEqual(versionStamps({ from: "/from", moduleDir }, () => true),
    [join("/from", "VERSION"), join("/x", "VERSION"), join("/x/project-template/.flow", "VERSION")],
    "--from's stamp leads: it is the very file buildPlan copies to the target's .flow/VERSION");

  // The three-levels-up candidate has to PROVE it is a canonical checkout — the same
  // project-template/ test buildPlan uses — or any directory that happens to sit there answers.
  assert.deepEqual(versionStamps({ moduleDir }, () => false),
    [join("/x/project-template/.flow", "VERSION")]);

  // First stamp that parses wins; an unreadable or non-numeric one is skipped, not fatal.
  const read = (p) => (p === join("/from", "VERSION") ? "not-a-version" : "5.2.1\n");
  assert.deepEqual(resolveDefaultRef({ from: "/from", moduleDir }, { exists: () => true, read }),
    { ref: "v5", stamp: join("/x", "VERSION") });
});
