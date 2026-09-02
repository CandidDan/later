// Tests for touches-guard — the scope enforcer enforces its own scope honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), "flow-tg-"));
  const bin = join(root, ".flow", "bin");
  mkdirSync(join(root, ".flow", "tasks"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const f of ["touches-guard.mjs", "parse-task-id.mjs"]) {
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
