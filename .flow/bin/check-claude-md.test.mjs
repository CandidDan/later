// check-claude-md.test.mjs — proving tests for the CLAUDE.md ceiling, one per acceptance
// criterion of flow-0050.
//
// THE BUG CLASS THESE PIN DOWN. The ceiling used to be a sentence in the template — nothing
// measured it, and CandidDan/Nudge sat 45% over it with nothing reporting it. The sentence also
// named the wrong ruler: `wc -c CLAUDE.md` cannot see an `@`-import, and an import IS loaded into
// the session in full. So the check that replaces the sentence has to be proved against the one
// thing a byte-counter gets wrong — a repo that halves `wc -c CLAUDE.md` while INCREASING the
// context it loads, which is exactly what adopting Flow does.
//
// PORTABILITY. `flow-sync` mirrors this directory into every adopting repo, so this file runs
// there too. The criteria about CANONICAL's own files (the template defaults, the reusable
// workflow, the adapter) are therefore guarded by `CANON`: present only in the repo that holds a
// `project-template/` beside its own `.flow/`, skipped everywhere else with the reason printed.
// The behavioural criteria are fixture-driven and run everywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEILING_KEY, ENTRY_ENV, ENTRY_FLAG, MAX_IMPORT_DEPTH, checkClaudeMd, main, parseCeiling,
  parseImports, resolveEntry, resolveImportSet,
} from "./check-claude-md.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── fixtures ────────────────────────────────────────────────────────────────────────────

const made = [];
/** A throwaway repo: `files` is relative-path → contents; `config` is `.flow/config.yml`'s text. */
function repo(files, config = null) {
  const dir = mkdtempSync(join(tmpdir(), "flow-cmd-"));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  if (config !== null) {
    mkdirSync(join(dir, ".flow"), { recursive: true });
    writeFileSync(join(dir, ".flow", "config.yml"), config);
  }
  return dir;
}
process.on("exit", () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Drive the CLI's `main` over a fixture, capturing both streams separately. */
function run(repoRoot, argv = [ENTRY_FLAG, HOST]) {
  const out = [];
  const err = [];
  const code = main(argv, {
    repoRoot,
    env: {},
    stdout: (s) => out.push(String(s)),
    stderr: (s) => err.push(String(s)),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

// The host file the gate passes in. The helper has no default — see `protocol-portability`: a bin
// helper may not name CLAUDE.md in executable code, so the binding lives in the caller.
const HOST = "CLAUDE.md";

const bytes = (...parts) => parts.reduce((n, p) => n + Buffer.byteLength(p, "utf8"), 0);
const ceiling = (n) => `project:\n  name: "x"\ncoverage_min: 80\n${CEILING_KEY}: ${n}\n`;
const noCeiling = 'project:\n  name: "x"\ncoverage_min: 80\n';

// Canonical, or null. Identified by holding BOTH this template tree and its own `.flow/bin`
// adapter — the shape no adopting repo has, because `flow-sync` copies the bin and not the tree.
const CANON = (() => {
  const root = resolve(HERE, "..", "..", "..");
  const isCanon = existsSync(join(root, "project-template", ".flow", "bin", "check-claude-md.mjs")) &&
    existsSync(join(root, ".flow", "bin", "check-claude-md.mjs"));
  return isCanon ? root : null;
})();
const notCanonical = "canonical-only: this repo has no project-template/ beside its own .flow/, " +
  "so there is no template default, reusable workflow or adapter here to assert on.";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 1 — an import's bytes are counted, not just CLAUDE.md's
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 1: @other.md's bytes are added to the total, not left out of it", () => {
  const root = "# root\n\n@other.md\n";
  const other = "imported prose that a session really does load\n";
  const dir = repo({ "CLAUDE.md": root, "other.md": other }, ceiling(10_000));

  const r = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(r.total, bytes(root, other),
    "the total must be the SUM of both files. Reporting only CLAUDE.md's bytes is the wc -c bug: " +
    "the import is resolved and loaded into the session in full.");
  assert.notEqual(r.total, bytes(root), "sanity: the two numbers must actually differ");
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["CLAUDE.md", "other.md"]);
  assert.equal(r.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 2 — transitive, and capped at Claude Code's depth limit
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 2a: a chain CLAUDE.md -> a.md -> b.md counts all three", () => {
  const dir = repo({
    "CLAUDE.md": "root\n@a.md\n",
    "a.md": "a\n@b.md\n",
    "b.md": "b — the transitive one\n",
  }, ceiling(10_000));

  const r = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["CLAUDE.md", "a.md", "b.md"],
    "imports are followed TRANSITIVELY — b.md reaches context via a.md and must be counted");
  assert.equal(r.total, bytes("root\n@a.md\n", "a\n@b.md\n", "b — the transitive one\n"));
});

test("criterion 2b: past MAX_IMPORT_DEPTH hops nothing is followed, and the output SAYS SO", () => {
  // The entry file is hop 0, so `MAX_IMPORT_DEPTH` of 5 loads h1..h5 and refuses h6 — which is
  // what Claude Code itself does, so counting h6 would overstate the context by a file that
  // never arrives. The chain below is deliberately one hop longer than the limit.
  const files = { "CLAUDE.md": "root\n@h1.md\n" };
  for (let i = 1; i <= 6; i++) files[`h${i}.md`] = `level ${i}\n${i < 6 ? `@h${i + 1}.md` : ""}\n`;
  const dir = repo(files, ceiling(10_000));

  const r = run(dir);
  const set = checkClaudeMd({ repoRoot: dir, entry: HOST });
  const counted = set.files.map((f) => f.path).sort();

  assert.equal(counted.length, MAX_IMPORT_DEPTH + 1,
    `only the first ${MAX_IMPORT_DEPTH} hops are followed, so ${MAX_IMPORT_DEPTH + 1} files are ` +
    `counted (the entry plus one per hop) — got ${counted.join(", ")}`);
  assert.ok(!counted.includes("h6.md"), "h6.md is 6 hops out and must NOT be counted");
  assert.equal(set.refused.length, 1, "the refusal is recorded, not swallowed");
  assert.match(set.refused[0], /h6\.md/, "the refusal must name the file that was not followed");
  assert.match(r.stdout, /h6\.md/,
    "REGRESSION: a silently-dropped file is indistinguishable from a file that was counted. The " +
    "depth limit has to be visible in the output or the total is unexplainable.");
  assert.equal(r.code, 0, "hitting the depth limit is a note, not a failure");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 3 — a diamond import is counted once
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 3: a file imported by two others is counted exactly once", () => {
  const shared = "shared prose, loaded once however many files point at it\n";
  const root = "root\n@a.md\n@b.md\n";
  const a = "a\n@shared.md\n";
  const b = "b\n@shared.md\n";
  const dir = repo({ "CLAUDE.md": root, "a.md": a, "b.md": b, "shared.md": shared }, ceiling(10_000));

  const r = checkClaudeMd({ repoRoot: dir, entry: HOST });
  const sharedEntries = r.files.filter((f) => f.path === "shared.md");
  assert.equal(sharedEntries.length, 1, "shared.md must appear once in the breakdown");
  assert.equal(r.total, bytes(root, a, b, shared),
    "double-counting a diamond would inflate the total above what the session actually loads");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 4 — backticks and fences are not imports
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 4: an @path inside backticks or a fenced block is not an import", () => {
  // Neither target exists. If either were read as an import the check would fail with
  // `unresolved-import` — so this test proves the exclusion by outcome, not by inspection.
  const root = [
    "# root",
    "",
    "Write the pointer as `@inline.md` when you are quoting it.",
    "",
    "```markdown",
    "@fenced.md",
    "```",
    "",
    "~~~",
    "@tilde-fenced.md",
    "~~~",
    "",
  ].join("\n");
  const dir = repo({ "CLAUDE.md": root }, ceiling(10_000));

  const r = run(dir);
  assert.equal(r.code, 0, `quoted @paths must not fail the check — stderr was: ${r.stderr}`);
  const set = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(set.total, bytes(root), "the total must equal CLAUDE.md's own size");
  assert.deepEqual(set.files.map((f) => f.path), ["CLAUDE.md"]);
  assert.deepEqual(parseImports(root), [],
    "Claude Code's parser skips both, which is exactly why the template says to leave the real " +
    "pointer outside backticks and outside code fences");
});

test("criterion 4 (converse): the same path OUTSIDE backticks and fences IS an import", () => {
  assert.deepEqual(parseImports("see @real.md for more\n"), ["real.md"],
    "the exclusion must not be so broad that it swallows the real import too");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 5 — an unresolved pointer fails; it is never counted as zero
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 5: @missing.md fails the check naming the path, rather than counting zero", () => {
  const dir = repo({ "CLAUDE.md": "root\n@missing.md\n" }, ceiling(10_000));

  const r = run(dir);
  assert.equal(r.code, 1,
    "REGRESSION: a repo that adds @.flow/PROTOCOL.md WITHOUT the file has a CLAUDE.md with no " +
    "protocol in it and no error anywhere. Counting the pointer as zero is how that passes.");
  assert.match(r.stderr, /missing\.md/, "the unresolved path must be named");
  assert.equal(checkClaudeMd({ repoRoot: dir, entry: HOST }).decision, "unresolved-import");
});

test("criterion 5 (the real case): the protocol import with no protocol file present fails", () => {
  const dir = repo({ "CLAUDE.md": "# Project protocol\n\n@.flow/PROTOCOL.md\n" }, ceiling(100_000));
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PROTOCOL\.md/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 6 — over the ceiling fails, with a largest-first breakdown
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 6: over claude_md_max exits non-zero with a per-file breakdown, largest first", () => {
  const big = `${"b".repeat(4000)}\n`;
  const mid = `${"m".repeat(2000)}\n`;
  const root = "root\n@big.md\n@mid.md\n";
  const dir = repo({ "CLAUDE.md": root, "big.md": big, "mid.md": mid }, ceiling(1000));

  const r = run(dir);
  assert.equal(r.code, 1, "over the ceiling must FAIL the gate — this is the coverage_min shape");
  const set = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(set.decision, "over-ceiling");
  assert.deepEqual(set.files.map((f) => f.path), ["big.md", "mid.md", "CLAUDE.md"],
    "ordered largest first, so the output names which file to cut instead of leaving the reader " +
    "to sort three numbers by hand");
  // Only the breakdown block, not the message above it — that names CLAUDE.md in its first
  // sentence, so scanning the whole stream would find the wrong occurrence.
  const marker = r.stderr.indexOf("largest first");
  assert.ok(marker > -1, "the breakdown must be introduced, so the ordering is legible");
  const block = r.stderr.slice(marker);
  const order = ["big.md", "mid.md", "CLAUDE.md"].map((p) => block.indexOf(p));
  assert.ok(order.every((i) => i > -1), "every file must appear in the printed breakdown");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "printed in that same order");
  assert.match(r.stderr, /1000/, "the ceiling it breached must be stated");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 7 — at or under the ceiling passes, printing total and headroom
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 7: at or under claude_md_max exits zero and prints the total and the headroom", () => {
  const root = "root\n@a.md\n";
  const a = "a\n";
  const dir = repo({ "CLAUDE.md": root, "a.md": a }, ceiling(10_000));
  const total = bytes(root, a);

  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(String(total)), "the resolved total must be printed");
  assert.match(r.stdout, new RegExp(String(10_000 - total)), "the headroom must be printed");
  assert.equal(checkClaudeMd({ repoRoot: dir, entry: HOST }).headroom, 10_000 - total);
});

test("criterion 7 (boundary): exactly AT the ceiling passes — it is a ceiling, not a limit below", () => {
  const root = "0123456789\n";
  const dir = repo({ "CLAUDE.md": root }, ceiling(bytes(root)));
  assert.equal(run(dir).code, 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 8 — an undeclared ceiling warns on stdout and exits zero
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 8: no claude_md_max declared exits zero with a 'no ceiling declared' warning on stdout", () => {
  const dir = repo({ "CLAUDE.md": "root\n" }, noCeiling);

  const r = run(dir);
  assert.equal(r.code, 0,
    "adoption must not break the fleet: every repo that pinned this workflow before the key " +
    "existed would go red at once if an absent ceiling were an error");
  assert.match(r.stdout, /no ceiling declared/,
    "on STDOUT and explicit — an unconfigured repo must LOOK unconfigured, not look clean");
  assert.doesNotMatch(r.stderr, /no ceiling declared/, "it is a warning, not an error");
  const set = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(set.decision, "no-ceiling-declared");
  assert.equal(set.ceiling, null);
  assert.ok(set.total > 0, "the total is still reported, so the number is visible before it is gated");
});

test("criterion 8 (not the same as absent): a present but unparseable ceiling IS an error", () => {
  const dir = repo({ "CLAUDE.md": "root\n" }, `${CEILING_KEY}: twenty-five-thousand\n`);
  const r = run(dir);
  assert.equal(r.code, 1,
    "a typo'd ceiling must not read as 'no ceiling' — that would switch the check off while " +
    "looking configured, which is the failure mode this whole task exists to remove");
  assert.match(r.stderr, /twenty-five-thousand/);
  assert.equal(parseCeiling(join(dir, ".flow", "config.yml")).value, null);
});

test("criterion 8 (no config at all): parseCeiling reports undeclared rather than throwing", () => {
  const dir = repo({ "CLAUDE.md": "root\n" });
  const c = parseCeiling(join(dir, ".flow", "config.yml"));
  assert.deepEqual([c.exists, c.declared], [false, false]);
  assert.equal(run(dir).code, 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 9 — no CLAUDE.md at all is a failure, not a pass
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 9: a repo with no root CLAUDE.md exits non-zero — an empty check is a failure", () => {
  const dir = repo({ "docs/notes.md": "not the entry point\n" }, ceiling(10_000));

  const r = run(dir);
  assert.equal(r.code, 1,
    "the same rule build and lint follow: a green check that measured nothing is the failure " +
    "mode they exist to prevent");
  assert.match(r.stderr, /CLAUDE\.md/, "the missing file must be named");
  const set = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(set.decision, "no-host-file");
  assert.equal(set.total, 0);
});

test("criterion 9 (a directory is not a file): CLAUDE.md as a directory fails the same way", () => {
  const dir = repo({ "CLAUDE.md/keep.txt": "x\n" }, ceiling(10_000));
  assert.equal(run(dir).code, 1);
  assert.ok(statSync(join(dir, "CLAUDE.md")).isDirectory(), "sanity: the fixture is a directory");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 10 — the template declares a default, beside coverage_min, commented
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 10: the template's .flow/config.yml declares claude_md_max beside coverage_min, commented with what it measures", (t) => {
  if (!CANON) return t.skip(notCanonical);
  const path = join(CANON, "project-template", ".flow", "config.yml");
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");

  const c = parseCeiling(path);
  assert.equal(c.declared, true, `the shipped template must declare ${CEILING_KEY}`);
  assert.ok(c.value > 0, "and it must be a usable default, not a REPLACE-ME sentinel");

  const cov = lines.findIndex((l) => /^coverage_min:/.test(l));
  const cmax = lines.findIndex((l) => new RegExp(`^${CEILING_KEY}:`).test(l));
  assert.ok(cov > -1 && cmax > cov, "it sits AFTER coverage_min, not in a section of its own");
  const between = lines.slice(cov + 1, cmax).filter((l) => /^[A-Za-z_][\w-]*:/.test(l));
  assert.deepEqual(between, [],
    "and immediately after it — no other top-level key in between, so the two thresholds read as " +
    "one idiom rather than two conventions");

  const comment = lines.slice(cov + 1, cmax).join("\n");
  assert.match(comment, /resolved import set/i, "the comment must say WHAT it measures");
  assert.match(comment, /wc -c/, "and must name the ruler it is not");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 11 — the template's budget paragraph tells the truth
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 11: project-template/CLAUDE.md no longer claims the protocol is free, and names wc -c as insufficient", (t) => {
  if (!CANON) return t.skip(notCanonical);
  const text = readFileSync(join(CANON, "project-template", "CLAUDE.md"), "utf8");

  assert.doesNotMatch(text, /protocol no longer counts/i,
    "the two sentences contradicted each other in the published artefact every repo copies: seven " +
    "lines above, the same file says the protocol 'arrives in full every session'");
  assert.match(text, /resolved import set/i, "it must state what the ceiling applies to");
  assert.match(text, /wc -c/, "and still mention wc -c —");
  assert.match(text, /not the measurement|not sufficient|insufficient/i,
    "— but only to say it is not the measurement");
  assert.match(text, /the protocol counts/i, "stated positively, so it cannot be misread");
  assert.match(text, new RegExp(CEILING_KEY), "and it must name the key that now carries the number");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 12 — the check is a step in the gate job, after the config read
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 12: _flow-gates.yml runs the check in the gate job, after the config read, and a failure fails the gate", (t) => {
  if (!CANON) return t.skip(notCanonical);
  // Scanned as text rather than parsed as YAML on purpose: `yaml` is a devDependency of canonical
  // and this file also runs in adopting repos, where no install step precedes `node --test`.
  const text = readFileSync(join(CANON, ".github", "workflows", "_flow-gates.yml"), "utf8");
  const gateStart = text.indexOf("\n  gate:");
  assert.ok(gateStart > -1, "sanity: the gate job exists");
  // The gate job runs to the next top-level job key (two-space indent at the start of a line).
  const rest = text.slice(gateStart + 1);
  const nextJob = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const gate = nextJob === -1 ? rest : rest.slice(0, nextJob);

  // The path is canonical's, not the caller's (flow-0094): the gate fetches
  // `project-template/.flow/bin/` at this workflow's own commit into `$FLOW_BIN` and runs that, so
  // a release that needs a new helper no longer breaks every pinned repo until it syncs.
  const invocation = gate.indexOf('node "$FLOW_BIN"/check-claude-md.mjs');
  assert.ok(invocation > -1,
    "REGRESSION: the check must run in the GATE job. A helper nothing invokes is the sentence in " +
    "the template all over again, only with tests.");
  assert.equal(gate.includes("node .flow/bin/check-claude-md.mjs"), false,
    "REGRESSION: the gate must not run the CALLER's copy — that is the 2.1.1 fleet break, where " +
    "every @v2 repo went red on a helper it had no way to have yet");
  const cfgRead = gate.indexOf("Read commands from .flow/config.yml");
  assert.ok(cfgRead > -1 && invocation > cfgRead, "it runs AFTER the config read");

  assert.match(gate.slice(invocation, invocation + 200), new RegExp(`${ENTRY_FLAG} \\S+`),
    "the gate step must PASS THE HOST FILE IN — the helper has no default (protocol-portability " +
    "forbids the filename in its code), so an invocation without it is a usage error, exit 2");

  const step = gate.slice(gate.lastIndexOf("- name:", invocation), invocation);
  assert.doesNotMatch(step, /continue-on-error/,
    "a failure must FAIL the gate — continue-on-error would make this advisory again");
  assert.doesNotMatch(gate.slice(invocation, invocation + 120), /\|\|\s*true/,
    "and its exit code must not be swallowed");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 13 — canonical's .flow/bin copy is an adapter, not a copy and not a symlink
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 13: .flow/bin/check-claude-md.mjs is a thin adapter — not a copy, not a symlink", (t) => {
  if (!CANON) return t.skip(notCanonical);
  const adapterPath = join(CANON, ".flow", "bin", "check-claude-md.mjs");
  const adapter = readFileSync(adapterPath, "utf8");
  const template = readFileSync(join(HERE, "check-claude-md.mjs"), "utf8");

  assert.equal(lstatSync(adapterPath).isSymbolicLink(), false,
    "a symlink would resolve back to the template and measure project-template/CLAUDE.md — the " +
    "WRONG repo, with every command still exiting 0");
  assert.match(adapter, /from "\.\.\/\.\.\/project-template\/\.flow\/bin\/check-claude-md\.mjs"/,
    "it must IMPORT the template's exported logic");
  assert.doesNotMatch(adapter, /export function resolveImportSet|const IMPORT_RE/,
    "and must not reimplement it — two implementations in the repo that authors the original is " +
    "one disagreement propagated to every other repo");
  assert.ok(adapter.length < template.length / 2,
    `the adapter is the CLI shell plus canonical's store location, nothing more ` +
    `(${adapter.length} vs ${template.length} bytes)`);
  assert.match(adapter, /canonicalRepoRoot/, "supplying canonical's own root is its whole job");
});

test("criterion 13 (the CLI runs, and against CANONICAL's root): silence is the symlink failure", (t) => {
  if (!CANON) return t.skip(notCanonical);
  const r = spawnSync(process.execPath, [join(CANON, ".flow", "bin", "check-claude-md.mjs"), ENTRY_FLAG, HOST, "--json"],
    { encoding: "utf8" });
  assert.equal(r.status, 0, `canonical's own gate must be green: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);

  assert.equal(payload.files[0].path, "CLAUDE.md");
  const canonicalBytes = Buffer.byteLength(readFileSync(join(CANON, "CLAUDE.md"), "utf8"), "utf8");
  assert.equal(payload.total, canonicalBytes,
    "the adapter measures CANONICAL's CLAUDE.md. If it were reading the template's tree the total " +
    "would include project-template/.flow/PROTOCOL.md and still look plausible.");
  const templateTotal = checkClaudeMd({ repoRoot: join(CANON, "project-template"), entry: HOST }).total;
  assert.notEqual(payload.total, templateTotal,
    "sanity: the two roots genuinely give different answers, so the assertion above has teeth");
  assert.equal(payload.decision, "within-ceiling",
    "canonical declares its own claude_md_max, so its verdict is enforced and not merely reported");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion 14's changelog half — the fragment names the caller action
// ─────────────────────────────────────────────────────────────────────────────────────────

test("criterion 14: the changelog fragment names the caller action, both halves of it", (t) => {
  if (!CANON) return t.skip(notCanonical);
  // Pending, the entry is `changes/flow-0050.md`. After a release runs `--assemble` the fragment
  // is deleted by design and the entry lives in CHANGELOG.md, whose file list ends `, flow-0050)`.
  // Either is the convention working; requiring the file made every release's own gate red.
  const path = join(CANON, "changes", "flow-0050.md");
  const text = existsSync(path)
    ? readFileSync(path, "utf8")
    : (readFileSync(join(CANON, "CHANGELOG.md"), "utf8").split(/\n(?=- \*\*)/)
        .find((e) => /`, flow-0050\)/.test(e)) ?? "");
  assert.ok(text, "the entry goes in changes/<task-id>.md (or, once released, CHANGELOG.md)");

  assert.match(text, /caller action/i, "the entry must state whether a caller has to act");
  assert.match(text, new RegExp(CEILING_KEY),
    "action one: an adopting repo must add the key or the check only warns");
  assert.match(text, /PROTOCOL\.md/,
    "action two: a repo carrying the import without the file now FAILS the gate");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Parser edges that would each silently change the number
// ─────────────────────────────────────────────────────────────────────────────────────────

test("an @path is resolved relative to the FILE CONTAINING IT, not to the repo root", () => {
  const dir = repo({
    "CLAUDE.md": "root\n@docs/a.md\n",
    "docs/a.md": "a\n@b.md\n",       // sibling of a.md, NOT of CLAUDE.md
    "docs/b.md": "b\n",
  }, ceiling(10_000));

  const r = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(r.ok, true, `resolution must be relative to docs/a.md: ${r.problems.join("; ")}`);
  assert.equal(r.files.length, 3);
});

test("an @path outside the repo is never followed: absolute, ../ and symlink all fail as unresolved", () => {
  // The walked file is PR-controlled. Were these followed, the gate would stat and read files on
  // the runner and print their paths and sizes into CI output. Each target below EXISTS, so the
  // only thing that can make it fail is the containment check, not a missing file.
  const outside = repo({ "secret.md": "s\n" });
  const abs = join(outside, "secret.md");
  const dir = repo({ "CLAUDE.md": `root\n@${abs}\n`, "inner/x.md": "x\n" }, ceiling(10_000));
  const up = relative(join(dir, "inner"), abs);
  writeFileSync(join(dir, "inner", "x.md"), `x\n@${up}\n`);
  writeFileSync(join(dir, "CLAUDE.md"), `root\n@${abs}\n@inner/x.md\n@link.md\n`);
  symlinkSync(abs, join(dir, "link.md"));

  const r = checkClaudeMd({ repoRoot: dir, entry: HOST });
  assert.equal(r.ok, false);
  assert.equal(r.decision, "unresolved-import");
  assert.equal(r.problems.filter((p) => /outside the repository/.test(p)).length, 3,
    `absolute, ../ and symlinked imports must each be refused: ${r.problems.join("; ")}`);
  assert.ok(!r.files.some((f) => /secret\.md/.test(f.path)), "the outside file must never be read");
});

test("an email address and a scoped package name are not imports", () => {
  assert.deepEqual(parseImports("mail you@example.com or install @anthropic-ai/claude-code\n"), [],
    "an unresolved @path is a HARD FAILURE, so a false positive on prose would fail a repo's " +
    "gate on a sentence. The narrow pattern is the safe direction of error.");
});

test("resolveImportSet counts the entry at depth 0 and each hop one deeper", () => {
  const dir = repo({ "CLAUDE.md": "r\n@a.md\n", "a.md": "a\n" });
  const { files } = resolveImportSet(dir, { entry: HOST });
  assert.deepEqual(files.map((f) => [f.path, f.depth]), [["CLAUDE.md", 0], ["a.md", 1]]);
});

test("--json emits the verdict as data and keeps the exit code", () => {
  const dir = repo({ "CLAUDE.md": `${"x".repeat(50)}\n` }, ceiling(10));
  const r = run(dir, [ENTRY_FLAG, HOST, "--json"]);
  assert.equal(r.code, 1);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.decision, "over-ceiling");
  assert.equal(payload.ceiling, 10);
});

test("the first stdout line is always the `check-claude-md: decision=` contract", () => {
  for (const [files, config] of [
    [{ "CLAUDE.md": "r\n" }, ceiling(10_000)],
    [{ "CLAUDE.md": "r\n" }, noCeiling],
    [{ "CLAUDE.md": `${"x".repeat(50)}\n` }, ceiling(5)],
    [{ "other.md": "r\n" }, ceiling(10_000)],
  ]) {
    const r = run(repo(files, config));
    assert.match(r.stdout.split("\n")[0], /^check-claude-md: decision=\S+ entry=\S+ total=\d+/,
      "the prose around it may be reworded; this prefix is a CI contract that may not be");
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The injected host file — the portability invariant this check has to live inside
// ─────────────────────────────────────────────────────────────────────────────────────────

test("no host file given is a USAGE error (exit 2), never an empty pass", () => {
  const dir = repo({ "CLAUDE.md": "root\n" }, ceiling(10_000));
  const r = run(dir, []);
  assert.equal(r.code, 2,
    "2, not 1: 'you invoked it wrong' must never read in a CI log as 'this repo is over its " +
    "ceiling' — and must never read as a pass either, which a baked-in default would hide");
  assert.match(r.stderr, new RegExp(ENTRY_FLAG));
  assert.throws(() => checkClaudeMd({ repoRoot: dir }), TypeError,
    "the library half refuses too, so a second caller cannot reintroduce the default");
});

test("the host file arrives from either --entry or the environment", () => {
  assert.equal(resolveEntry([ENTRY_FLAG, "AGENTS.md"], {}), "AGENTS.md");
  assert.equal(resolveEntry([], { [ENTRY_ENV]: "AGENTS.md" }), "AGENTS.md");
  assert.equal(resolveEntry([ENTRY_FLAG, "A.md"], { [ENTRY_ENV]: "B.md" }), "A.md",
    "the explicit flag wins over ambient environment");
  assert.equal(resolveEntry([ENTRY_FLAG, "--json"], {}), null,
    "a flag swallowing the next flag as its value would measure a file called '--json'");
  assert.equal(resolveEntry([], {}), null, "and there is NO default");
});

test("the check measures whatever host file it is handed, not one hard-coded name", () => {
  const dir = repo({ "CLAUDE.md": `${"c".repeat(500)}\n`, "AGENTS.md": "agents\n" }, ceiling(10_000));
  const a = checkClaudeMd({ repoRoot: dir, entry: "AGENTS.md" });
  assert.deepEqual(a.files.map((f) => f.path), ["AGENTS.md"],
    "this is the portability the injected entry buys: the ceiling is about a host file, and which " +
    "host file a repo has is that repo's business");
  assert.equal(a.total, bytes("agents\n"));
  assert.notEqual(a.total, checkClaudeMd({ repoRoot: dir, entry: HOST }).total);
});

// ── The repo-root contract (flow-0094, ADR-0008) ────────────────────────────────────────
//
// `_flow-gates.yml` fetches canonical's `project-template/.flow/bin/` at the running workflow's
// own commit and runs this helper from there, so the workflow and the helper it needs arrive as
// one unit instead of the helper waiting on a flow-sync PR. From that checkout the module-relative
// default measures CANONICAL's fixture host file against canonical's uncalibrated config — and
// prints a plausible number, and exits 0. These prove it measures the repo it was pointed at.
function canonicalCheckout() {
  const root = mkdtempSync(join(tmpdir(), "flow-canon-"));
  const bin = join(root, "project-template", ".flow", "bin");
  mkdirSync(bin, { recursive: true });
  // The decoy the fallback would find: a host file and a ceiling that belong to neither target.
  writeFileSync(join(root, "project-template", "HOST.md"), "x".repeat(4321) + "\n");
  mkdirSync(join(root, "project-template", ".flow"), { recursive: true });
  writeFileSync(join(root, "project-template", ".flow", "config.yml"), "claude_md_max: 99999\n");
  for (const f of ["check-claude-md.mjs", "source-roots.mjs"]) {
    writeFileSync(join(bin, f), readFileSync(join(import.meta.dirname, f), "utf8"));
  }
  return { root, helper: join(bin, "check-claude-md.mjs") };
}

function targetRepo(ceiling, bytes) {
  const root = mkdtempSync(join(tmpdir(), "flow-target-"));
  mkdirSync(join(root, ".flow"), { recursive: true });
  writeFileSync(join(root, ".flow", "config.yml"), `claude_md_max: ${ceiling}\n`);
  writeFileSync(join(root, "HOST.md"), "y".repeat(bytes - 1) + "\n");
  return root;
}

function runHelper(helper, env, cwd) {
  const r = spawnSync(process.execPath, [helper, "--entry", "HOST.md"], {
    cwd, encoding: "utf8", env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("run from outside the repo with FLOW_REPO_DIR set, the ceiling check measures the repo it was pointed at", () => {
  const { root: canon, helper } = canonicalCheckout();
  // Two repos that share no number: different ceilings and different host-file sizes, so every
  // field of the verdict identifies which one was actually read.
  const a = targetRepo(8000, 1234);
  const b = targetRepo(7000, 2345);
  const neutral = mkdtempSync(join(tmpdir(), "flow-cwd-"));
  try {
    const ra = runHelper(helper, { FLOW_CI: "1", FLOW_REPO_DIR: a }, neutral);
    assert.equal(ra.code, 0, ra.out);
    assert.match(ra.out, /ceiling=8000/);
    assert.match(ra.out, /total=1234\b/);
    assert.doesNotMatch(ra.out, /99999/, "it must not have measured the checkout it was loaded from");

    const rb = runHelper(helper, { FLOW_CI: "1", FLOW_REPO_DIR: b }, neutral);
    assert.equal(rb.code, 0, rb.out);
    assert.match(rb.out, /ceiling=7000/);
    assert.match(rb.out, /total=2345\b/);
  } finally {
    for (const d of [canon, a, b, neutral]) rmSync(d, { recursive: true, force: true });
  }
});

test("in CI mode with FLOW_REPO_DIR unset, the ceiling check exits non-zero and names the variable", () => {
  const { root: canon, helper } = canonicalCheckout();
  const a = targetRepo(8000, 1234);
  try {
    const r = runHelper(helper, { FLOW_CI: "1" }, a);
    assert.notEqual(r.code, 0, "a silent fallback is what would make a wrong measurement green");
    assert.match(r.out, /FLOW_REPO_DIR/);
    assert.doesNotMatch(r.out, /check-claude-md: decision=/, "it must not reach a verdict at all");
  } finally {
    for (const d of [canon, a]) rmSync(d, { recursive: true, force: true });
  }
});

test("without FLOW_CI the helper keeps its old behaviour — a repo on an older workflow tag still works", () => {
  // A repo that has synced new helpers but is still pinned to an older `_flow-gates.yml` sets
  // neither variable. That is the 2.1.x break with the halves swapped, and it must not happen.
  const { root: canon } = canonicalCheckout();
  const a = targetRepo(8000, 1234);
  try {
    mkdirSync(join(a, ".flow", "bin"), { recursive: true });
    for (const f of ["check-claude-md.mjs", "source-roots.mjs"]) {
      writeFileSync(join(a, ".flow", "bin", f), readFileSync(join(import.meta.dirname, f), "utf8"));
    }
    const r = runHelper(join(a, ".flow", "bin", "check-claude-md.mjs"), { GITHUB_ACTIONS: "true" }, a);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ceiling=8000/);
  } finally {
    for (const d of [canon, a]) rmSync(d, { recursive: true, force: true });
  }
});
