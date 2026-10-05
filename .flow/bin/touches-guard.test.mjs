// Tests for touches-guard — the scope enforcer enforces its own scope honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { globToRegExp, checkTouches, parseTouches } from "./touches-guard.mjs";

// Fixture frontmatters mirroring the two shapes the task store actually uses.
const MULTILINE_FM = `---
id: "CAN-46"
status: "in_progress"
touches:
  - "app/src/components/quick-wins/**"
  - "app/scripts/check-css-discipline.mjs"
labels: [dashboard, infra]
---
body text here
`;

const INLINE_FM = `---
id: "CAN-33"
touches: [".flow/bin/flow-doctor.mjs", ".flow/config.yml"]
labels: [flow-infra]
---
`;

// AC#1 — multi-line YAML list parses to exactly its globs, order preserved.
test("parseTouches: multi-line YAML list (CAN-57 criterion 1)", () => {
  assert.deepEqual(parseTouches(MULTILINE_FM), [
    "app/src/components/quick-wins/**",
    "app/scripts/check-css-discipline.mjs",
  ]);
});

// AC#2 — inline-array form still parses unchanged (no regression).
test("parseTouches: inline array still works (CAN-57 criterion 2)", () => {
  assert.deepEqual(parseTouches(INLINE_FM), [".flow/bin/flow-doctor.mjs", ".flow/config.yml"]);
});

test("parseTouches: tolerates single-quoted and unquoted list items", () => {
  const fm = `---\ntouches:\n  - 'a/**'\n  - b.json\n---\n`;
  assert.deepEqual(parseTouches(fm), ["a/**", "b.json"]);
});

// AC#3 — a multi-line-touches task with an out-of-scope changed file is rejected.
test("parseTouches + checkTouches: multi-line out-of-scope file is caught (CAN-57 criterion 3)", () => {
  const touches = parseTouches(MULTILINE_FM);
  const r = checkTouches({
    changedFiles: [
      "app/src/components/quick-wins/quick-wins.tsx", // in scope
      "app/src/lib/__tests__/design-tokens.test.ts", // OUT of scope (the real CAN-47 drift)
    ],
    touches,
  });
  assert.deepEqual(r.outside, ["app/src/lib/__tests__/design-tokens.test.ts"]);
});

// AC#4 — a multi-line-touches task fully in scope passes.
test("parseTouches + checkTouches: multi-line fully in-scope passes (CAN-57 criterion 4)", () => {
  const touches = parseTouches(MULTILINE_FM);
  const r = checkTouches({
    changedFiles: [
      "app/src/components/quick-wins/quick-wins.tsx",
      "app/scripts/check-css-discipline.mjs",
    ],
    touches,
  });
  assert.deepEqual(r.outside, []);
  assert.equal(r.checked, 2);
});

// AC#5 — a genuinely empty/absent declaration still returns [] (warn-and-pass preserved).
test("parseTouches: empty inline and missing key both yield [] (CAN-57 criterion 5)", () => {
  assert.deepEqual(parseTouches(`---\ntouches: []\nlabels: [x]\n---\n`), []);
  assert.deepEqual(parseTouches(`---\nid: "CAN-99"\nstatus: "ready"\n---\n`), []);
});

test("parseTouches: stops at the next frontmatter key, not into the body", () => {
  const fm = `---\ntouches:\n  - "a/**"\nlabels: [x]\nnotes:\n  - "- not a touch"\n---\nbody\n  - "definitely not a touch"\n`;
  assert.deepEqual(parseTouches(fm), ["a/**"]);
});

test("parseTouches: ignores a `touches:` example in the body, not the frontmatter", () => {
  // A task with no frontmatter touches key, but whose body prose shows a touches example
  // (exactly the shape of the CAN-57 task file). Must return [] — the body is never parsed.
  const fm = `---\nid: "CAN-99"\nstatus: "ready"\n---\n\n## Scope\n\nDeclare it like:\n\ntouches:\n  - "src/should-not-be-read/**"\n`;
  assert.deepEqual(parseTouches(fm), []);
});

test("parseTouches: skips comment lines and strips trailing item comments", () => {
  const fm = `---\ntouches:\n  # the lint script\n  - "app/scripts/check.mjs"\n  - "app/x/**"  # the component dir\n---\n`;
  assert.deepEqual(parseTouches(fm), ["app/scripts/check.mjs", "app/x/**"]);
});

test("globToRegExp: ** spans path segments", () => {
  const re = globToRegExp("src/components/signup/**");
  assert.ok(re.test("src/components/signup/Form.tsx"));
  assert.ok(re.test("src/components/signup/nested/deep/x.ts"));
  assert.ok(!re.test("src/components/other/x.ts"));
});

test("globToRegExp: * matches any non-slash run; does not cross /", () => {
  const re = globToRegExp("src/lib/validation/email.*");
  assert.ok(re.test("src/lib/validation/email.ts"));
  assert.ok(re.test("src/lib/validation/email.test.ts"));        // * spans dots — same segment
  assert.ok(!re.test("src/lib/validation/email/index.ts"));      // * does NOT cross a slash
});

test("globToRegExp: exact file path", () => {
  const re = globToRegExp("app/vercel.json");
  assert.ok(re.test("app/vercel.json"));
  assert.ok(!re.test("app/vercel.jsonc"));
  assert.ok(!re.test("vercel.json"));
});

test("checkTouches: in-scope files pass, out-of-scope reported", () => {
  const r = checkTouches({
    changedFiles: ["src/signup/Form.tsx", "app/scripts/generate-state.mjs", "docs/DESIGN-SYNOPSIS.md"],
    touches: ["src/signup/**", "CLAUDE.md"],
  });
  assert.deepEqual(r.outside.sort(), ["app/scripts/generate-state.mjs", "docs/DESIGN-SYNOPSIS.md"]);
});

test("checkTouches: the CAN-30 drift would have failed", () => {
  // Real case: task touched CLAUDE.md/state.yml/ARCHITECTURE/Project-Context but drifted into the generator.
  const r = checkTouches({
    changedFiles: ["CLAUDE.md", "docs/state.yml", "docs/ARCHITECTURE.md", "app/scripts/generate-state.mjs", "docs/DESIGN-SYNOPSIS.md"],
    touches: ["CLAUDE.md", "docs/state.yml", "docs/ARCHITECTURE.md", "Project-Context.md"],
  });
  assert.deepEqual(r.outside.sort(), ["app/scripts/generate-state.mjs", "docs/DESIGN-SYNOPSIS.md"]);
});

test("checkTouches: .flow/ is excluded (store-guard's domain)", () => {
  const r = checkTouches({
    changedFiles: [".flow/tasks/0030-x.md", ".flow/board.html", "CLAUDE.md"],
    touches: ["CLAUDE.md"],
  });
  assert.deepEqual(r.outside, []);
  assert.equal(r.checked, 1);
});

test("checkTouches: ['**'] opts out entirely", () => {
  const r = checkTouches({
    changedFiles: ["anything/at/all.ts", "x.md"],
    touches: ["**"],
  });
  assert.deepEqual(r.outside, []);
});

// ── CLI id-resolution ──────────────────────────────────────────────────────────
// The guard used to match `flow/<id>-…` on the branch alone, so every cloud-session PR
// (forced onto `claude/…` by the platform) skipped scope enforcement silently. These
// exercise the real CLI end to end: a throwaway git repo, a task file, and a diff that
// strays outside `touches`. The criterion is "the guard actually runs", so the assertion
// is on the exit code and the drift being named — not on the parser in isolation.
// Every file the guard needs at runtime. `source-roots.mjs` is on the list because the guard
// imports the repo-root contract (`resolveRepoRoot`) from it — see that function's header for why
// it lives there rather than in a module of its own.
const HELPER_FILES = ["touches-guard.mjs", "parse-task-id.mjs", "source-roots.mjs"];

function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), "flow-tg-"));
  const bin = join(root, ".flow", "bin");
  mkdirSync(join(root, ".flow", "tasks"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const f of HELPER_FILES) {
    copyFileSync(join(import.meta.dirname, f), join(bin, f));
  }
  writeFileSync(join(root, ".flow", "tasks", "0030-x.md"),
    '---\nid: "CAN-30"\ntouches: ["src/**"]\n---\nbody\n');

  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "base");
  // The drift: a file outside the declared `src/**` radius.
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "drift.md"), "drift\n");
  git("add", "-A"); git("commit", "-qm", "drift");
  return root;
}

function runGuard(root, env) {
  try {
    const stdout = execFileSync("node", [join(root, ".flow", "bin", "touches-guard.mjs")], {
      cwd: root, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, BASE_REF: "HEAD~1", ...env },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("CLI: a claude/… branch with an [id] PR title is enforced, not skipped", () => {
  const root = cliFixture();
  const r = runGuard(root, { HEAD_REF: "claude/blissful-edison-3srhxo", PR_TITLE: "[CAN-30] Do the thing" });
  assert.equal(r.code, 1, "drift outside touches must fail the gate");
  assert.match(r.out, /docs\/drift\.md/);
  rmSync(root, { recursive: true, force: true });
});

test("CLI: a flow/<id>-… branch still resolves from the branch alone", () => {
  const root = cliFixture();
  const r = runGuard(root, { HEAD_REF: "flow/CAN-30-x", PR_TITLE: "" });
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/drift\.md/);
  rmSync(root, { recursive: true, force: true });
});

test("CLI: no id in either branch or title still skips cleanly", () => {
  const root = cliFixture();
  const r = runGuard(root, { HEAD_REF: "dependabot/npm/x", PR_TITLE: "Bump x from 1 to 2" });
  assert.equal(r.code, 0);
  assert.match(r.out, /no task id in branch/);
  rmSync(root, { recursive: true, force: true });
});

// ── The repo-root contract (flow-0094, ADR-0008) ────────────────────────────────────────
//
// `_flow-gates.yml` no longer runs the caller's copy of this guard. It fetches canonical's
// `project-template/.flow/bin/` at the running workflow's own commit and runs THAT, so a release
// can change a workflow and its helper together instead of breaking every pinned repo until it
// syncs. The hazard that creates is silent: from a canonical checkout the guard's module-relative
// default resolves to canonical's own fixture store, finds no task file for the caller's id,
// prints `decision=skipped reason=no-task-file` and exits 0 — scope enforcement off, gate green.
//
// So these run the guard from a directory that is NOT the repo under test, laid out exactly as the
// fetched canonical checkout is (`<tmp>/project-template/.flow/bin`), and prove it reads the repo
// it was POINTED AT rather than the one it was loaded from.
function foreignBin() {
  const root = mkdtempSync(join(tmpdir(), "flow-canon-"));
  const bin = join(root, "project-template", ".flow", "bin");
  mkdirSync(bin, { recursive: true });
  // The decoy: a task store beside the helpers, which is what canonical really has. A guard that
  // fell back to its own directory would read THIS and pass.
  mkdirSync(join(root, "project-template", ".flow", "tasks"), { recursive: true });
  writeFileSync(join(root, "project-template", ".flow", "tasks", "0030-decoy.md"),
    '---\nid: "CAN-30"\ntouches: ["**"]\n---\ndecoy\n');
  for (const f of HELPER_FILES) copyFileSync(join(import.meta.dirname, f), join(bin, f));
  return { root, guard: join(bin, "touches-guard.mjs") };
}

// A repo whose ONLY task is `id`, declaring `touches`, with `drift` committed outside it.
function targetRepo(id, touches, drift) {
  const root = mkdtempSync(join(tmpdir(), "flow-target-"));
  mkdirSync(join(root, ".flow", "tasks"), { recursive: true });
  writeFileSync(join(root, ".flow", "tasks", `${id}.md`),
    `---\nid: "${id}"\ntouches: ["${touches}"]\n---\nbody\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "base");
  mkdirSync(join(root, dirname(drift)), { recursive: true });
  writeFileSync(join(root, drift), "drift\n");
  git("add", "-A"); git("commit", "-qm", "drift");
  return root;
}

function runForeign(guard, env, cwd) {
  try {
    return { code: 0, out: execFileSync("node", [guard], {
      cwd, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, BASE_REF: "HEAD~1", ...env },
    }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("run from outside the repo with FLOW_REPO_DIR set, the guard reads the repo it was pointed at", () => {
  const { root: canon, guard } = foreignBin();
  // Two repos that disagree about everything a wrong answer could be read from: the task id, the
  // declared radius, and which file is the drift. Only the target's id can appear in the verdict.
  const a = targetRepo("CAN-41", "src/**", "docs/drift-a.md");
  const b = targetRepo("CAN-42", "docs/**", "src/drift-b.js");
  try {
    const neutral = mkdtempSync(join(tmpdir(), "flow-cwd-"));
    const ra = runForeign(guard, { FLOW_CI: "1", FLOW_REPO_DIR: a, HEAD_REF: "flow/CAN-41-x" }, neutral);
    assert.equal(ra.code, 1, "the target's drift must fail the gate");
    assert.match(ra.out, /CAN-41/);
    assert.doesNotMatch(ra.out, /CAN-42/);
    assert.match(ra.out, /docs\/drift-a\.md/);

    const rb = runForeign(guard, { FLOW_CI: "1", FLOW_REPO_DIR: b, HEAD_REF: "flow/CAN-42-x" }, neutral);
    assert.equal(rb.code, 1);
    assert.match(rb.out, /CAN-42/);
    assert.doesNotMatch(rb.out, /CAN-41/);
    assert.match(rb.out, /src\/drift-b\.js/);
    rmSync(neutral, { recursive: true, force: true });
  } finally {
    for (const d of [canon, a, b]) rmSync(d, { recursive: true, force: true });
  }
});

test("in CI mode with FLOW_REPO_DIR unset, the guard exits non-zero and names the variable", () => {
  const { root: canon, guard } = foreignBin();
  const a = targetRepo("CAN-41", "src/**", "docs/drift-a.md");
  try {
    const r = runForeign(guard, { FLOW_CI: "1", HEAD_REF: "flow/CAN-41-x" }, a);
    assert.notEqual(r.code, 0, "a silent fallback to its own directory is the failure this closes");
    assert.match(r.out, /FLOW_REPO_DIR/);
    // And it must not have quietly judged anything: no decision line at all.
    assert.doesNotMatch(r.out, /touches-guard: decision=/);
  } finally {
    for (const d of [canon, a]) rmSync(d, { recursive: true, force: true });
  }
});

test("without FLOW_CI the guard keeps its old behaviour — a repo on an older workflow tag still works", () => {
  // The mirror image of the 2.1.x break: a repo that has SYNCED new helpers but is still pinned to
  // an older `_flow-gates.yml` invokes them with neither variable set. That must keep working, and
  // it is why the CI-mode signal is an explicit opt-in rather than `GITHUB_ACTIONS`.
  const root = cliFixture();
  const r = runGuard(root, { HEAD_REF: "flow/CAN-30-x", PR_TITLE: "", GITHUB_ACTIONS: "true" });
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/drift\.md/);
  rmSync(root, { recursive: true, force: true });
});
