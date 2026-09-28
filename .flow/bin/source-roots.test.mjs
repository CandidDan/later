// source-roots.test.mjs — proving tests for flow-0077.
//
// The criteria this file proves, one section each:
//
//   · three source_roots whose checks differ from every `commands.*` → a three-entry matrix
//     carrying each entry's own path, check, runtime, version and retry, defaults filled in
//   · an entry whose `check` equals `commands.lint` is EXCLUDED; canonical's own config plans 0
//   · an entry whose `path` or `check` is REPLACE-ME is excluded and `plan` still exits 0
//   · `runtime: python`, `retry: 5`, and an unknown field each fail `plan`, naming the entry
//     and the field
//   · `run` with a check that fails once then succeeds and `retry: 1` exits 0 and logs that
//     attempt 2 succeeded; the same check with `retry: 0` exits non-zero
//   · the parser move changed nothing flow-doctor reads (proved here against the OLD line-scan's
//     shape, and in flow-doctor.test.mjs by its 90 tests continuing to pass unedited)
//
// WHY THE EXCLUSION RULE GETS ITS OWN SECTION. "Run every declared check" was the obvious design
// and it is wrong: canonical's four entries are all `npm run lint` / `npm run build`, so it would
// re-run lint three times per PR for nothing. The rule that prevents that is invisible in the
// output it produces — an empty matrix — which is exactly the shape a broken plan also produces.
// So both are asserted, with the reason attached, rather than one `assert.equal(count, 0)`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_RETRY, DEFAULT_RUNTIME, DEFAULT_VERSIONS, ENTRY_FIELDS, MAX_RETRY, PLACEHOLDER,
  PRIMARY_COMMAND_KEYS, RUNTIMES, isPlaceholder, main, parseCommands, parseSourceRoots,
  planSourceRoots, runCheck,
} from "./source-roots.mjs";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Fixtures — a real repo root on disk, because `plan` checks for a lockfile beside each tree
// ─────────────────────────────────────────────────────────────────────────────────────────

const COMMANDS = [
  'commands:',
  '  install: "npm ci"',
  '  build: "npm run build"',
  '  lint: "npm run lint"          # a trailing comment must not become part of the command',
  '  test: "npm test"',
  '  coverage: "npm run coverage"',
  '',
].join("\n");

/** Write a repo whose `.flow/config.yml` holds `commands:` plus the given source_roots text. */
function repo(sourceRootsBlock, { dirs = [], files = {}, commands = COMMANDS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flow-sr-"));
  mkdirSync(join(root, ".flow"), { recursive: true });
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  writeFileSync(join(root, ".flow", "config.yml"), `${commands}\n${sourceRootsBlock}\n`);
  return root;
}
const configOf = (root) => join(root, ".flow", "config.yml");
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const planOf = (root) => planSourceRoots({ configPath: configOf(root), repoRoot: root });

/** `main()` with every side effect captured instead of performed. */
function runMain(argv, opts = {}) {
  const out = [], err = [], appended = [];
  const code = main(argv, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    appendOutput: (s) => appended.push(s),
    env: {},
    ...opts,
  });
  return { code, out, err, appended, stdout: out.join("\n"), stderr: err.join("\n") };
}

const THREE_TREES = [
  'source_roots:',
  '  - path: "supabase/functions/"',
  '    check: "deno check supabase/functions/**/*.ts"',
  '    runtime: "deno"',
  '    retry: 1',
  '  - path: "mcp/"',
  '    check: "cd mcp && npm ci && npm run build"',
  '  - path: "mobile/"',
  '    check: "cd mobile && npm ci && npx tsc --noEmit"',
  '    version: "20"',
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion: three roots whose checks differ from every commands.* → a three-entry matrix
// ─────────────────────────────────────────────────────────────────────────────────────────

test("three source_roots outside the primary commands → a three-entry matrix, each carrying its own fields", () => {
  const root = repo(THREE_TREES, { dirs: ["supabase/functions", "mcp", "mobile"] });
  const { matrix, count, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 3);
  assert.equal(matrix.length, 3);

  assert.deepEqual(matrix.map((e) => e.path), ["supabase/functions/", "mcp/", "mobile/"],
    "order follows the config, so a failing job is findable by eye");
  assert.deepEqual(matrix.map((e) => e.check), [
    "deno check supabase/functions/**/*.ts",
    "cd mcp && npm ci && npm run build",
    "cd mobile && npm ci && npx tsc --noEmit",
  ], "the check travels verbatim — install steps live inside it, by design");
  assert.deepEqual(matrix.map((e) => e.runtime), ["deno", "node", "node"]);
  assert.deepEqual(matrix.map((e) => e.retry), [1, 0, 0]);
  cleanup(root);
});

test("defaults are FILLED IN, not left absent — a matrix entry is never partially specified", () => {
  const root = repo(THREE_TREES, { dirs: ["supabase/functions", "mcp", "mobile"] });
  const { matrix } = planOf(root);
  for (const e of matrix) {
    for (const k of ["path", "check", "runtime", "version", "retry"]) {
      assert.ok(Object.hasOwn(e, k), `matrix entry for ${e.path} has no ${k}`);
    }
  }
  const [deno, mcp, mobile] = matrix;
  assert.equal(deno.version, DEFAULT_VERSIONS.deno, "an unversioned deno entry takes the deno default");
  assert.equal(mcp.runtime, DEFAULT_RUNTIME, "runtime defaults to node");
  assert.equal(mcp.version, DEFAULT_VERSIONS.node, "an unversioned node entry takes the node default");
  assert.equal(mcp.retry, DEFAULT_RETRY, "retry defaults to 0 — no silent retrying");
  assert.equal(mobile.version, "20", "an explicit version wins over the default");
  cleanup(root);
});

test("runtime `none` gets no version — there is no setup step to hand one to", () => {
  const root = repo([
    'source_roots:',
    '  - path: "api/"',
    '    check: "uv run ruff check api"',
    '    runtime: "none"',
    '    version: "3.12"',
  ].join("\n"), { dirs: ["api"] });
  const { matrix, errors } = planOf(root);
  assert.deepEqual(errors, [], "`version` alongside `none` is ignored, not rejected");
  assert.equal(matrix[0].runtime, "none");
  assert.equal(matrix[0].version, "", "the field stays present and empty so the matrix shape is uniform");
  assert.equal(matrix[0].cache, "", "`none` never asks setup-node for a cache");
  cleanup(root);
});

test("the npm cache keys on the tree's OWN lockfile, and only when it has one", () => {
  const withLock = repo([
    'source_roots:',
    '  - path: "mcp/"',
    '    check: "cd mcp && npm ci && npm run build"',
    '  - path: "mobile/"',
    '    check: "cd mobile && npx tsc --noEmit"',
  ].join("\n"), { dirs: ["mobile"], files: { "mcp/package-lock.json": "{}\n" } });
  const { matrix } = planSourceRoots({ configPath: configOf(withLock), repoRoot: withLock });
  assert.equal(matrix[0].cache, "npm");
  assert.equal(matrix[0].cache_dependency_path, join("mcp/", "package-lock.json"));
  assert.equal(matrix[1].cache, "", "a tree with no lockfile gets no cache rather than one keyed on the wrong file");
  assert.equal(matrix[1].cache_dependency_path, "");
  cleanup(withLock);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion: an entry whose check equals a primary command is excluded; canonical plans 0
// ─────────────────────────────────────────────────────────────────────────────────────────

test("an entry whose `check` equals commands.lint is EXCLUDED — the gate job already runs it", () => {
  const root = repo([
    'source_roots:',
    '  - path: "app/"',
    '    check: "npm run lint"',
    '  - path: "mcp/"',
    '    check: "cd mcp && npm run build"',
  ].join("\n"), { dirs: ["app", "mcp"] });
  const { matrix, count, excluded, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 1);
  assert.deepEqual(matrix.map((e) => e.path), ["mcp/"]);
  assert.deepEqual(excluded, [{ path: "app/", reason: "covered by the primary gate" }],
    "the exclusion is reported, never silent — an empty matrix must be explicable");
  cleanup(root);
});

test("each of build, lint, test and coverage excludes a matching entry — not lint alone", () => {
  const declared = parseCommands(configOf(repo("source_roots:\n")));
  for (const key of PRIMARY_COMMAND_KEYS) {
    const command = declared[key];
    assert.ok(command, `the fixture must declare commands.${key} for this to prove anything`);
    const root = repo(`source_roots:\n  - path: "app/"\n    check: "${command}"\n`, { dirs: ["app"] });
    const { count, excluded } = planOf(root);
    assert.equal(count, 0, `commands.${key} ("${command}") must exclude its matching entry`);
    assert.equal(excluded[0].reason, "covered by the primary gate");
    cleanup(root);
  }
});

test("a check that merely RESEMBLES a primary command still runs — the match is exact equality", () => {
  const root = repo([
    'source_roots:',
    '  - path: "app/"',
    '    check: "npm run lint:app"',
  ].join("\n"), { dirs: ["app"] });
  const { count, matrix } = planOf(root);
  assert.equal(count, 1, "`npm run lint:app` is not `npm run lint` and the gate job does not run it");
  assert.equal(matrix[0].check, "npm run lint:app");
  cleanup(root);
});

test("canonical's own .flow/config.yml plans a count of 0 — every entry is already gated", () => {
  const canonicalRoot = resolve(import.meta.dirname, "..", "..", "..");
  const configPath = join(canonicalRoot, ".flow", "config.yml");
  const { matrix, count, excluded, errors } = planSourceRoots({ configPath, repoRoot: canonicalRoot });
  assert.deepEqual(errors, [], "canonical's own config must satisfy the schema it publishes");
  assert.equal(count, 0);
  assert.deepEqual(matrix, []);
  assert.ok(excluded.length >= 4,
    "count 0 must be four entries EXCLUDED, not zero entries parsed — a parser that found nothing " +
    "produces the same 0 and would be a silent hole");
  for (const x of excluded) assert.equal(x.reason, "covered by the primary gate");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion: a REPLACE-ME path or check is excluded, and plan still exits 0
// ─────────────────────────────────────────────────────────────────────────────────────────

test("the shipped REPLACE-ME entry is excluded and `plan` exits 0 — adoption must not fail the gate", () => {
  const root = repo([
    'source_roots:',
    '  - path: "REPLACE-ME/"',
    '    check: "REPLACE-ME"',
  ].join("\n"));
  const { count, excluded, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 0);
  assert.deepEqual(excluded, [{ path: "REPLACE-ME/", reason: "uncalibrated" }]);
  assert.equal(runMain(["plan"], { configPath: configOf(root), repoRoot: root }).code, 0);
  cleanup(root);
});

test("a half-calibrated entry — real path, REPLACE-ME check — is excluded too, and named", () => {
  const root = repo([
    'source_roots:',
    '  - path: "app/"',
    '    check: "REPLACE-ME"',
    '  - path: "mcp/"',
    '    check: "cd mcp && npm run build"',
  ].join("\n"), { dirs: ["app", "mcp"] });
  const { count, excluded, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 1, "the calibrated sibling still runs");
  assert.deepEqual(excluded, [{ path: "app/", reason: "uncalibrated" }]);
  cleanup(root);
});

test("the published template's own config plans 0 and exits 0 — a fresh adoption is green", () => {
  const configPath = join(import.meta.dirname, "..", "config.yml");
  const repoRoot = resolve(import.meta.dirname, "..", "..");
  const { count, errors, excluded } = planSourceRoots({ configPath, repoRoot });
  assert.deepEqual(errors, []);
  assert.equal(count, 0);
  assert.ok(excluded.some((x) => x.reason === "uncalibrated"),
    "the shipped config must still carry the REPLACE-ME sentinel INIT.md tells adopters to replace");
});

test("a config with no source_roots block at all plans 0 without erroring", () => {
  const root = repo("");
  const { count, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 0);
  cleanup(root);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion: runtime: python, retry: 5, or an unknown field → non-zero, naming entry + field
// ─────────────────────────────────────────────────────────────────────────────────────────

const badEntry = (extra) => repo([
  'source_roots:',
  '  - path: "app/"',
  '    check: "cd app && npm run typecheck"',
  `    ${extra}`,
].join("\n"), { dirs: ["app"] });

test("`runtime: python` fails, naming the entry and the field", () => {
  const root = badEntry('runtime: "python"');
  const { errors, count } = planOf(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /source_root "app\/"/, "the entry must be named");
  assert.match(errors[0], /"runtime"/, "the field must be named");
  assert.match(errors[0], /node, deno, none/, "and the legal values, so the fix needs no docs trip");
  assert.equal(count, 0);
  const r = runMain(["plan"], { configPath: configOf(root), repoRoot: root });
  assert.equal(r.code, 1, "plan must exit non-zero");
  assert.match(r.stderr, /^::error::/m, "and annotate the run, not just print");
  assert.equal(r.stdout, "", "nothing is emitted on the failure path — a half-plan is worse than none");
  cleanup(root);
});

test("`retry: 5` fails, naming the entry, the field and the cap", () => {
  const root = badEntry("retry: 5");
  const { errors, count } = planOf(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /source_root "app\/"/);
  assert.match(errors[0], /"retry"/);
  assert.match(errors[0], new RegExp(`between 0 and ${MAX_RETRY}`));
  assert.equal(count, 0);
  assert.equal(runMain(["plan"], { configPath: configOf(root), repoRoot: root }).code, 1);
  cleanup(root);
});

test("a negative retry and a non-integer retry both fail — the bound is two-sided", () => {
  for (const value of ["-1", "1.5", "one", "true"]) {
    const root = badEntry(`retry: ${value}`);
    const { errors } = planOf(root);
    assert.equal(errors.length, 1, `retry: ${value} must be rejected`);
    assert.match(errors[0], /"retry"/);
    cleanup(root);
  }
});

test("retry 0 and retry 3 are accepted — the cap is inclusive at both ends", () => {
  for (const value of [0, MAX_RETRY]) {
    const root = badEntry(`retry: ${value}`);
    const { errors, matrix } = planOf(root);
    assert.deepEqual(errors, [], `retry: ${value} must be legal`);
    assert.equal(matrix[0].retry, value);
    cleanup(root);
  }
});

test("an unknown field fails, naming the entry, the field and the fields that DO exist", () => {
  const root = badEntry('retires: "1"');
  const { errors, count } = planOf(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /source_root "app\/"/);
  assert.match(errors[0], /"retires"/);
  for (const f of ENTRY_FIELDS) assert.ok(errors[0].includes(f), `the error must list the legal field ${f}`);
  assert.equal(count, 0);
  assert.equal(runMain(["plan"], { configPath: configOf(root), repoRoot: root }).code, 1);
  cleanup(root);
});

test("an unknown field on an UNCALIBRATED entry still fails — the typo is the point, not the run", () => {
  const root = repo([
    'source_roots:',
    '  - path: "REPLACE-ME/"',
    '    check: "REPLACE-ME"',
    '    retires: "1"',
  ].join("\n"));
  const { errors } = planOf(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"retires"/);
  cleanup(root);
});

test("an entry with an empty check is an error naming the field, not a silently skipped tree", () => {
  const root = repo('source_roots:\n  - path: "app/"\n    check: ""\n', { dirs: ["app"] });
  const { errors, count } = planOf(root);
  assert.equal(count, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"check"/);
  cleanup(root);
});

test("every error is reported in one run — a plan does not stop at the first bad entry", () => {
  const root = repo([
    'source_roots:',
    '  - path: "a/"',
    '    check: "x"',
    '    runtime: "python"',
    '  - path: "b/"',
    '    check: "y"',
    '    retry: 9',
  ].join("\n"), { dirs: ["a", "b"] });
  const { errors } = planOf(root);
  assert.equal(errors.length, 2, "fixing one field and re-running to find the next is a wasted CI cycle each time");
  assert.match(errors[0], /source_root "a\/"/);
  assert.match(errors[1], /source_root "b\/"/);
  cleanup(root);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Criterion: run retries, exits on the last attempt's status, and logs which attempt won
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A spawn stub that fails the first `failures` calls, then succeeds. */
function flaky(failures) {
  let n = 0;
  const calls = [];
  const spawn = (check, opts) => {
    calls.push({ check, opts });
    n += 1;
    return { status: n <= failures ? 1 : 0 };
  };
  return { spawn, calls };
}

test("a check that fails once then succeeds, with retry 1: exit 0, and the log says attempt 2 succeeded", () => {
  const { spawn, calls } = flaky(1);
  const log = [];
  const code = runCheck({ check: "deno check x.ts", retry: 1, cwd: "/repo", spawn, log: (s) => log.push(s) });
  assert.equal(code, 0);
  assert.equal(calls.length, 2, "exactly 1 + retry attempts, no more");
  assert.ok(log.includes("source-roots: attempt 1/2 failed (exit 1)"), log.join("\n"));
  assert.ok(log.includes("source-roots: attempt 2/2 succeeded"),
    `the run must say which attempt won — a retry that hides the flake is the flake with the evidence removed:\n${log.join("\n")}`);
});

test("the same check with retry 0: one attempt, non-zero exit, and the log says all attempts failed", () => {
  const { spawn, calls } = flaky(1);
  const log = [];
  const code = runCheck({ check: "deno check x.ts", retry: 0, cwd: "/repo", spawn, log: (s) => log.push(s) });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, "retry 0 means exactly one attempt — the default must not retry silently");
  assert.ok(log.includes("source-roots: all 1 attempt(s) failed (exit 1)"), log.join("\n"));
});

test("a check that fails every attempt exhausts 1 + retry and exits with the last status", () => {
  const { spawn, calls } = flaky(99);
  const log = [];
  const code = runCheck({ check: "false", retry: MAX_RETRY, cwd: "/repo", spawn, log: (s) => log.push(s) });
  assert.equal(code, 1);
  assert.equal(calls.length, 1 + MAX_RETRY);
  assert.ok(log.includes(`source-roots: all ${1 + MAX_RETRY} attempt(s) failed (exit 1)`), log.join("\n"));
});

test("a check killed by a signal (status null) counts as a failure, not a pass", () => {
  const log = [];
  const code = runCheck({
    check: "sleep 100", retry: 0, cwd: "/repo", log: (s) => log.push(s),
    spawn: () => ({ status: null, signal: "SIGKILL" }),
  });
  assert.equal(code, 1, "a null status is how spawnSync reports a signal death — treating it as 0 would pass a killed check");
});

test("the check runs from the repo root, through a shell, exactly as written", () => {
  const seen = [];
  runCheck({
    check: "cd mcp && npm ci && npm run build", retry: 0, cwd: "/srv/repo", log: () => {},
    spawn: (check, opts) => { seen.push({ check, opts }); return { status: 0 }; },
  });
  assert.equal(seen[0].check, "cd mcp && npm ci && npm run build", "the command is never rewritten or split");
  assert.equal(seen[0].opts.cwd, "/srv/repo", "the same convention commands.* uses");
  assert.equal(seen[0].opts.shell, true, "`cd x && y` is shell syntax; without a shell it is a missing binary");
  assert.equal(seen[0].opts.stdio, "inherit", "the check's own output must reach the job log");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The CLI: `plan` emits the two outputs, `run` takes its values from the environment
// ─────────────────────────────────────────────────────────────────────────────────────────

test("`plan` emits matrix= and count= to stdout AND to $GITHUB_OUTPUT", () => {
  const root = repo(THREE_TREES, { dirs: ["supabase/functions", "mcp", "mobile"] });
  const r = runMain(["plan"], {
    configPath: configOf(root), repoRoot: root, env: { GITHUB_OUTPUT: "/dev/null" },
  });
  assert.equal(r.code, 0);
  const matrixLine = r.out.find((l) => l.startsWith("matrix="));
  const countLine = r.out.find((l) => l.startsWith("count="));
  assert.ok(matrixLine && countLine, r.stdout);
  assert.equal(countLine, "count=3");
  const parsed = JSON.parse(matrixLine.slice("matrix=".length));
  assert.equal(parsed.include.length, 3, "the matrix is an `include:` list, which is what fromJSON needs");
  assert.ok(!matrixLine.includes("\n"), "a multi-line value would corrupt the $GITHUB_OUTPUT file format");
  assert.deepEqual(r.appended, ["matrix=" + JSON.stringify({ include: parsed.include }) + "\n", "count=3\n"]);
  cleanup(root);
});

test("`plan` writes nothing to $GITHUB_OUTPUT when it is unset — a local run is not a broken run", () => {
  const root = repo(THREE_TREES, { dirs: ["supabase/functions", "mcp", "mobile"] });
  const r = runMain(["plan"], { configPath: configOf(root), repoRoot: root, env: {} });
  assert.equal(r.code, 0);
  assert.deepEqual(r.appended, []);
  cleanup(root);
});

test("`run` reads its check and retry from the environment, never from argv interpolation", () => {
  const seen = [];
  const r = runMain(["run"], {
    repoRoot: "/srv/repo",
    env: { FLOW_SOURCE_ROOT_CHECK: "deno check 'a b'.ts", FLOW_SOURCE_ROOT_RETRY: "1", FLOW_SOURCE_ROOT_PATH: "supabase/functions/" },
    spawn: (check) => { seen.push(check); return { status: seen.length > 1 ? 0 : 1 }; },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(seen, ["deno check 'a b'.ts", "deno check 'a b'.ts"]);
  assert.match(r.stdout, /gating "supabase\/functions\/"/, "the log must say which tree this job is");
});

test("`run` with no check is an ::error naming the variable, not a silent success", () => {
  const r = runMain(["run"], { repoRoot: "/srv/repo", env: {}, spawn: () => ({ status: 0 }) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /::error::/);
  assert.match(r.stderr, /FLOW_SOURCE_ROOT_CHECK/);
});

test("an unknown subcommand exits non-zero with a usage line", () => {
  const r = runMain(["plot"], { repoRoot: "/srv/repo", configPath: "/nope" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The parser move: what flow-doctor reads is byte-identical to what it read before
// ─────────────────────────────────────────────────────────────────────────────────────────

test("parseSourceRoots keeps flow-doctor's contract: exists/declared/roots with path and check", () => {
  const root = repo([
    'source_roots:',
    '  - path: "app/"          # a trailing comment',
    "    check: 'npm run lint'",
    '  - path: "mcp/"',
    '    check: "cd mcp && npm run build"',
  ].join("\n"));
  const parsed = parseSourceRoots(configOf(root));
  assert.equal(parsed.declared, true);
  assert.deepEqual(parsed.roots.map((r) => ({ path: r.path, check: r.check })), [
    { path: "app/", check: "npm run lint" },
    { path: "mcp/", check: "cd mcp && npm run build" },
  ], "quotes stripped, trailing comments dropped, both quote styles handled — exactly as before");
  cleanup(root);
});

test("parseSourceRoots still reports a missing file and an undeclared block distinctly", () => {
  assert.deepEqual(parseSourceRoots(join(tmpdir(), `flow-sr-missing-${process.pid}`)),
    { exists: false, declared: false, roots: [] });
  const root = repo("");
  assert.deepEqual(parseSourceRoots(configOf(root)), { exists: true, declared: false, roots: [] },
    "a config with no source_roots is the adoption warning, and must not look like a missing config");
  cleanup(root);
});

test("the block ends at the next top-level key — a later `security:` is not read as a root", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-sr-"));
  mkdirSync(join(root, ".flow"));
  writeFileSync(join(root, ".flow", "config.yml"),
    'source_roots:\n  - path: "app/"\n    check: "x"\n\nsecurity:\n  secrets_scan: true\n');
  const parsed = parseSourceRoots(configOf(root));
  assert.equal(parsed.roots.length, 1);
  assert.equal(parsed.roots[0].path, "app/");
  cleanup(root);
});

test("the dash-on-its-own-line list form still parses — the bare dash starts the entry", () => {
  const root = repo('source_roots:\n  -\n    path: "app/"\n    check: "x"\n  -\n    path: "mcp/"\n    check: "y"\n');
  const parsed = parseSourceRoots(configOf(root));
  assert.deepEqual(parsed.roots.map((r) => r.path), ["app/", "mcp/"]);
  cleanup(root);
});

test("an entry's keys may come in any order — `path:` after another field does not split the entry", () => {
  // Reviewer's repro on PR #109: `path:` used to start a SECOND entry, so this read as one entry
  // with no path (a misleading "path is empty") plus one whose runtime fell back to node.
  const root = repo([
    'source_roots:',
    '  - runtime: "deno"',
    '    path: "supabase/"',
    '    check: "deno check"',
    '  -',
    '    check: "cd mcp && npm run build"',
    '    path: "mcp/"',
  ].join("\n"), { dirs: ["supabase", "mcp"] });
  const parsed = parseSourceRoots(configOf(root));
  assert.deepEqual(parsed.roots.map((r) => ({ path: r.path, check: r.check, runtime: r.fields.runtime })), [
    { path: "supabase/", check: "deno check", runtime: "deno" },
    { path: "mcp/", check: "cd mcp && npm run build", runtime: undefined },
  ]);
  const { matrix, errors } = planOf(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(matrix.map((e) => [e.path, e.runtime]), [["supabase/", "deno"], ["mcp/", "node"]]);
  cleanup(root);
});

test("parseCommands reads the four primary commands, comments and quotes stripped", () => {
  const root = repo("source_roots:\n");
  const cmds = parseCommands(configOf(root));
  assert.equal(cmds.lint, "npm run lint", "a trailing `# comment` must not become part of the command");
  assert.equal(cmds.build, "npm run build");
  assert.equal(cmds.test, "npm test");
  assert.equal(cmds.coverage, "npm run coverage");
  assert.deepEqual(parseCommands(join(tmpdir(), `flow-sr-missing-${process.pid}`)), {});
  cleanup(root);
});

test("the sentinel helpers still behave as flow-doctor needs them to", () => {
  assert.equal(PLACEHOLDER, "REPLACE-ME");
  assert.ok(isPlaceholder("REPLACE-ME"));
  assert.ok(isPlaceholder("REPLACE-ME/"), "a trailing slash must not defeat the sentinel");
  assert.ok(!isPlaceholder("app/"));
  assert.ok(!isPlaceholder(undefined));
});

test("the schema constants are frozen — an accidental push() would widen the schema silently", () => {
  for (const c of [ENTRY_FIELDS, RUNTIMES, PRIMARY_COMMAND_KEYS, DEFAULT_VERSIONS]) {
    assert.ok(Object.isFrozen(c));
  }
  assert.deepEqual([...RUNTIMES], ["node", "deno", "none"]);
  assert.deepEqual([...ENTRY_FIELDS], ["path", "check", "runtime", "version", "retry"]);
});
