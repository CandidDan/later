// main-module.test.mjs — the CLI entry points must run when reached through a SYMLINK.
//
// The bug this pins down (2026-08-11): every bin helper gated its CLI on
//   import.meta.url === `file://${process.argv[1]}`
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reach the
// script through a symlink and they differ, the comparison is false, and the CLI block silently
// never runs — no output, no error, exit 0.
//
// Why it hid for so long: macOS `os.tmpdir()` is /var/folders/... symlinked to /private/var/...,
// so it fired on every local test run — while Linux CI checks out to a real path and never saw it.
// A platform-specific test would have stayed invisible to CI, so these tests build the symlink
// EXPLICITLY and therefore fail on any platform if the guard regresses.
//
// Why it matters more than a broken test: touches-guard FAILS OPEN. When the CLI block doesn't
// run, the scope check silently doesn't happen and the gate goes green — enforcement off, nothing
// reported. parse-task-id fails the same way, and it feeds flow-status / flow-done, so a lost id
// means the PR-event transition never fires and the task strands on `main`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionLine, DECISION_PREFIX } from "./touches-guard.mjs";

// Build <root>/real/.flow/bin/<files> and <root>/link -> <root>/real, so a path through `link`
// is a genuine symlink on every platform, not just where the OS happens to provide one.
function symlinkedFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "flow-symlink-"));
  const bin = join(root, "real", ".flow", "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "real", ".flow", "tasks"), { recursive: true });
  for (const f of files) copyFileSync(join(import.meta.dirname, f), join(bin, f));
  symlinkSync(join(root, "real"), join(root, "link"), "dir");
  return { root, viaReal: join(root, "real"), viaLink: join(root, "link") };
}

test("parse-task-id CLI resolves an id when invoked through a symlink", () => {
  const fx = symlinkedFixture(["parse-task-id.mjs"]);
  const run = (base) =>
    execFileSync("node", [join(base, ".flow", "bin", "parse-task-id.mjs"), "flow/CAN-30-x", ""],
      { encoding: "utf8", stdio: "pipe" }).trim();

  assert.equal(run(fx.viaReal), "CAN-30", "sanity: works via the real path");
  assert.equal(run(fx.viaLink), "CAN-30",
    "REGRESSION: the CLI block did not run through the symlink — main-module detection is comparing " +
    "an as-invoked path against a resolved one. Every helper silently no-ops in this state.");
  rmSync(fx.root, { recursive: true, force: true });
});

test("touches-guard still ENFORCES scope when invoked through a symlink (fails open otherwise)", () => {
  const fx = symlinkedFixture(["touches-guard.mjs", "parse-task-id.mjs"]);
  writeFileSync(join(fx.viaReal, ".flow", "tasks", "0030-x.md"),
    '---\nid: "CAN-30"\ntouches: ["src/**"]\n---\nbody\n');

  const git = (...a) => execFileSync("git", a, { cwd: fx.viaReal, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(fx.viaReal, "seed.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "base");
  mkdirSync(join(fx.viaReal, "docs"), { recursive: true });
  writeFileSync(join(fx.viaReal, "docs", "drift.md"), "drift\n");   // outside the declared src/**
  git("add", "-A"); git("commit", "-qm", "drift");

  let code = 0;
  try {
    execFileSync("node", [join(fx.viaLink, ".flow", "bin", "touches-guard.mjs")], {
      cwd: fx.viaLink, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, BASE_REF: "HEAD~1", HEAD_REF: "flow/CAN-30-x", PR_TITLE: "" },
    });
  } catch (e) { code = e.status; }

  assert.equal(code, 1,
    "REGRESSION AND FAIL-OPEN: drift outside `touches` was not caught when the guard was reached " +
    "through a symlink. The gate would go green with scope enforcement silently disabled.");
  rmSync(fx.root, { recursive: true, force: true });
});

// ── flow-0008: the guard must PROVE it ran ───────────────────────────────────────────────
//
// The realpath fix above stops this particular silent no-op. It does not stop the *class*:
// any path on which the guard exits 0 without saying what it decided is indistinguishable, to
// the gate, from a guard that found nothing wrong. So every exit path now prints one
// `touches-guard: decision=…` line, and `_flow-gates.yml` fails the job when that line is
// absent (proved separately, against the shipped shell, in `.flow/bin/gate-assertion.test.mjs`).
//
// These tests own the guard's half of that contract: the line is emitted, exactly once, on
// every path — including through a symlink, where the CLI used not to run at all.

// A throwaway repo with a task declaring `touches: ["src/**"]` and a diff that strays outside
// it. `bodyTouches` lets a test swap in a different declaration (or none).
function guardFixture({ bodyTouches = 'touches: ["src/**"]\n', drift = true } = {}) {
  const fx = symlinkedFixture(["touches-guard.mjs", "parse-task-id.mjs"]);
  writeFileSync(join(fx.viaReal, ".flow", "tasks", "0030-x.md"),
    `---\nid: "CAN-30"\n${bodyTouches}---\nbody\n`);

  const git = (...a) => execFileSync("git", a, { cwd: fx.viaReal, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(fx.viaReal, "seed.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "base");
  const rel = drift ? ["docs", "drift.md"] : ["src", "ok.mjs"];
  mkdirSync(join(fx.viaReal, rel[0]), { recursive: true });
  writeFileSync(join(fx.viaReal, ...rel), "x\n");
  git("add", "-A"); git("commit", "-qm", "change");
  return fx;
}

function runVia(base, env) {
  try {
    const out = execFileSync("node", [join(base, ".flow", "bin", "touches-guard.mjs")], {
      cwd: base, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, BASE_REF: "HEAD~1", HEAD_REF: "flow/CAN-30-x", PR_TITLE: "", ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const decisionLines = (out) =>
  out.split("\n").filter((l) => l.startsWith("touches-guard: decision="));

// AC#1 — drift outside `touches`: the guard states `enforced` AND fails.
test("flow-0008 AC#1: out-of-scope drift prints an `enforced` decision and exits non-zero", () => {
  const fx = guardFixture();
  const r = runVia(fx.viaReal, {});
  assert.equal(r.code, 1, "drift outside touches must fail the gate");
  assert.match(r.out,
    /^touches-guard: decision=enforced reason=out-of-scope task=CAN-30 checked=\d+ globs=\d+ outside=1$/m,
    `expected an enforced decision line naming the outcome; got:\n${r.out}`);
  rmSync(fx.root, { recursive: true, force: true });
});

test("flow-0008: an in-scope diff is also `enforced` — a pass is stated, not assumed", () => {
  const fx = guardFixture({ drift: false });
  const r = runVia(fx.viaReal, {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^touches-guard: decision=enforced reason=in-scope task=CAN-30 .* outside=0$/m);
  rmSync(fx.root, { recursive: true, force: true });
});

// AC#2 — the three legitimate skips each name their reason and stay green.
test("flow-0008 AC#2: no resolvable task id skips with a named reason, and passes", () => {
  const fx = guardFixture();
  const r = runVia(fx.viaReal, { HEAD_REF: "dependabot/npm/x", PR_TITLE: "Bump x from 1 to 2" });
  assert.equal(r.code, 0, "a dependabot PR with no task id must still go green");
  assert.match(r.out, /^touches-guard: decision=skipped reason=no-task-id task=-/m);
  rmSync(fx.root, { recursive: true, force: true });
});

test("flow-0008 AC#2: an id with no task file skips with `no-task-file`", () => {
  const fx = guardFixture();
  const r = runVia(fx.viaReal, { HEAD_REF: "flow/CAN-99-x" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^touches-guard: decision=skipped reason=no-task-file task=CAN-99/m);
  rmSync(fx.root, { recursive: true, force: true });
});

test("flow-0008 AC#2: a task declaring no touches skips with `no-touches-declared`", () => {
  const fx = guardFixture({ bodyTouches: "" });
  const r = runVia(fx.viaReal, {});
  assert.equal(r.code, 0);
  assert.match(r.out, /^touches-guard: decision=skipped reason=no-touches-declared task=CAN-30/m);
  rmSync(fx.root, { recursive: true, force: true });
});

// AC#4 — the symlink path is the one that used to produce nothing at all.
test("flow-0008 AC#4: through a symlink the guard still emits its decision AND enforces", () => {
  const fx = guardFixture();
  const r = runVia(fx.viaLink, {});
  assert.equal(r.code, 1,
    "FAIL-OPEN: drift outside `touches` was not caught through the symlink.");
  assert.match(r.out, /^touches-guard: decision=enforced reason=out-of-scope task=CAN-30 /m,
    "the guard enforced but said nothing the gate can check — through a symlink is exactly " +
    "where it used to say nothing at all.");
  rmSync(fx.root, { recursive: true, force: true });
});

// Exactly one line, on every path: the gate greps for a prefix, so a second line would make
// "which decision" ambiguous and a zero-line path is the bug this whole task closes.
test("flow-0008: every exit path prints exactly one decision line", () => {
  const cases = [
    ["enforced/out-of-scope", guardFixture(), {}],
    ["enforced/in-scope", guardFixture({ drift: false }), {}],
    ["skipped/no-task-id", guardFixture(), { HEAD_REF: "x/y", PR_TITLE: "no id" }],
    ["skipped/no-task-file", guardFixture(), { HEAD_REF: "flow/CAN-99-x" }],
    ["skipped/no-touches-declared", guardFixture({ bodyTouches: "" }), {}],
  ];
  for (const [label, fx, env] of cases) {
    const lines = decisionLines(runVia(fx.viaReal, env).out);
    assert.equal(lines.length, 1, `${label}: expected 1 decision line, got ${lines.length}`);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// AC#5's guard-side half: the vocabulary is enumerated, so a new exit path cannot invent an
// unrecognised reason and quietly widen what the gate accepts.
test("flow-0008 AC#5: decisionLine rejects a decision or reason outside the enumeration", () => {
  assert.throws(() => decisionLine({ decision: "maybe", reason: "in-scope" }), /unknown decision/);
  assert.throws(() => decisionLine({ decision: "skipped", reason: "in-scope" }),
    /not valid for decision 'skipped'/);
  assert.equal(
    decisionLine({ decision: "skipped", reason: "no-task-id" }).startsWith(DECISION_PREFIX), true);
});
