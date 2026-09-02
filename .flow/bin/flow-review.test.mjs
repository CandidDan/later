// flow-review.test.mjs — proving tests for the deterministic half of the review gate (flow-0007).
//
// The model call is not the gate; these functions are. Two failure modes matter more than the
// rest and both are asserted in the fail-closed direction:
//
//   · a reviewer that produced no verdict, an empty one, or unparseable JSON must FAIL the
//     check. Reading any of those as a pass would make the whole gate theatre, and it is the
//     mode that shows up exactly when something already went wrong.
//   · a repo that has not scoped `review.security_paths` must get the security review on every
//     PR, not none of them.
//
// Zero dependencies on purpose: `_flow-gates.yml`'s `flow-tooling` job runs
// `node --test .flow/bin/*.test.mjs` with no install step, so anything imported here has to be
// in Node itself.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKS,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MODEL,
  ReviewError,
  boundDiff,
  parseReviewConfig,
  parseVerdict,
  reviewBlock,
  runPlan,
  runReviewCli,
  securityDecision,
  verdictOutcome,
} from "./flow-review.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const CLI = join(BIN, "flow-review.mjs");

const tmp = (name) => mkdtempSync(join(tmpdir(), `flow-review-${name}-`));
const run = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });

// A config.yml shaped like the real one: the review block sits between other top-level keys, so
// the block reader has to stop at the next column-0 key rather than swallowing the rest.
const CONFIG = `project:
  name: "demo"

review:
  model: "haiku"
  security_model: "opus"
  security_paths:
    - "src/auth/**"          # trailing comment
    - "package.json"

git:
  base_branch: "main"
  security_paths:            # a decoy OUTSIDE the review block
    - "everything/**"
`;

// ── config parsing ────────────────────────────────────────────────────────────────────────

test("reviewBlock reads only the review: block, stopping at the next top-level key", () => {
  const block = reviewBlock(CONFIG);
  assert.match(block, /model: "haiku"/);
  assert.match(block, /src\/auth\/\*\*/);
  assert.doesNotMatch(block, /base_branch/, "the block must end at the next column-0 key");
  assert.doesNotMatch(block, /everything/, "a same-named key outside the block must not leak in");
});

test("reviewBlock returns null when the repo has no review: block at all", () => {
  assert.equal(reviewBlock("project:\n  name: x\n"), null);
  assert.equal(reviewBlock(""), null);
});

// Criterion 5: the model comes from config. No model is written into the reusable workflow.
test("parseReviewConfig takes the reviewer model from config.yml", () => {
  const cfg = parseReviewConfig(CONFIG);
  assert.equal(cfg.model, "haiku");
  assert.equal(cfg.securityModel, "opus");
  assert.deepEqual(cfg.securityPaths, ["src/auth/**", "package.json"]);
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.warnings, [], "a fully configured repo warns about nothing");
});

test("parseReviewConfig accepts the inline-array form of security_paths", () => {
  const cfg = parseReviewConfig(`review:\n  model: sonnet\n  security_paths: ["a/**", 'b.json']\n`);
  assert.equal(cfg.model, "sonnet", "an unquoted scalar is as valid as a quoted one");
  assert.deepEqual(cfg.securityPaths, ["a/**", "b.json"]);
});

test("security_model falls back to model, and model to the documented default — each with a warning", () => {
  const one = parseReviewConfig(`review:\n  model: "opus"\n`);
  assert.equal(one.securityModel, "opus", "one knob unless the repo asks for two");

  const none = parseReviewConfig(`review:\n  security_paths: []\n`);
  assert.equal(none.model, DEFAULT_MODEL);
  assert.ok(none.warnings.some((w) => /review\.model is not set/.test(w)),
    "falling back to a default must be reported, or an unconfigured repo looks configured");

  const absent = parseReviewConfig("project:\n  name: x\n");
  assert.equal(absent.configured, false);
  assert.equal(absent.model, DEFAULT_MODEL);
  assert.ok(absent.warnings.some((w) => /no `review:` block/.test(w)));
});

// ── the conditional security review (criterion 3) ─────────────────────────────────────────

test("the security review RUNS when the diff touches a configured trigger path", () => {
  const d = securityDecision({
    changedFiles: ["README.md", "src/auth/session.ts"],
    securityPaths: ["src/auth/**", "package.json"],
  });
  assert.equal(d.run, true);
  assert.deepEqual(d.matched, ["src/auth/session.ts"]);
  assert.match(d.reason, /src\/auth\/session\.ts/, "the reason must name what triggered it");
});

test("the security review is SKIPPED when the diff touches none of them — and the skip says why", () => {
  const d = securityDecision({
    changedFiles: ["docs/copy.md", "src/ui/Button.tsx"],
    securityPaths: ["src/auth/**", "package.json"],
  });
  assert.equal(d.run, false);
  assert.match(d.reason, /SKIPPED/);
  assert.match(d.reason, /src\/auth\/\*\*/, "a skip must name the trigger list it was measured against");
  assert.match(d.reason, /not an omission/, "a silent skip is indistinguishable from a broken gate");
});

test("an unconfigured trigger list runs the security review on EVERY PR — fail-closed", () => {
  const d = securityDecision({ changedFiles: ["README.md"], securityPaths: [] });
  assert.equal(d.run, true, `"nobody scoped it yet" must never read as "nothing to review here"`);
  assert.match(d.reason, /no `review\.security_paths` configured/);
});

test("a model name that would splice extra flags into the reviewer is rejected at the config", () => {
  // Whole config lines, not values: a quote character only survives in the unquoted form.
  for (const line of [
    `model: "sonnet --dangerously-skip-permissions"`,
    `model: a"b`,
    `model: "-leading-dash"`,
    `model: "x y"`,
    `security_model: "opus --print"`,
  ]) {
    assert.throws(() => parseReviewConfig(`review:\n  ${line}\n`),
      (e) => e instanceof ReviewError && /not a usable model name/.test(e.message),
      `${JSON.stringify(line)} reaches the reviewer as \`--model <value>\` and must not pass`);
  }
  // A real model id is a bare identifier and must keep working.
  assert.equal(parseReviewConfig(`review:\n  model: "claude-opus-5"\n`).model, "claude-opus-5");
});

test("securityDecision survives an empty diff and a `**` trigger", () => {
  assert.equal(securityDecision({ changedFiles: [], securityPaths: ["src/**"] }).run, false);
  assert.equal(securityDecision({ changedFiles: ["x"], securityPaths: ["**"] }).run, true);
});

// ── the bounded context (criterion 7) ─────────────────────────────────────────────────────

test("a diff under the cap is passed through untouched", () => {
  const r = boundDiff("diff --git a/x b/x\n", { maxBytes: 1000 });
  assert.equal(r.truncated, false);
  assert.equal(r.text, "diff --git a/x b/x\n");
});

test("an oversized diff is truncated AND told the reviewer it was truncated", () => {
  const r = boundDiff("x".repeat(5000), { maxBytes: 100 });
  assert.equal(r.truncated, true);
  assert.equal(r.fullBytes, 5000);
  assert.match(r.text, /DIFF TRUNCATED at 100 bytes \(full diff is 5000 bytes\)/);
  assert.match(r.text, /rather than approving what you could not read/,
    "a clipped diff a reviewer thinks is whole is worse than no review");
  assert.ok(DEFAULT_MAX_DIFF_BYTES > 0);
});

test("runPlan writes ONLY the changed files and the bounded diff — the reviewer's whole context", () => {
  const dir = tmp("plan");
  try {
    writeFileSync(join(dir, "config.yml"), CONFIG);
    const calls = [];
    const plan = runPlan({
      configPath: join(dir, "config.yml"),
      outDir: join(dir, "out"),
      baseRef: "origin/main",
      git: (args) => {
        calls.push(args.join(" "));
        return args.includes("--name-only")
          ? "src/auth/session.ts\nREADME.md\n"
          : "diff --git a/src/auth/session.ts b/src/auth/session.ts\n+token\n";
      },
    });

    assert.deepEqual(calls, [
      "diff --name-only origin/main...HEAD",
      "diff origin/main...HEAD",
    ], "the context is the PR diff and nothing else — no whole-repo read");

    assert.equal(readFileSync(join(dir, "out", "files.txt"), "utf8"), "src/auth/session.ts\nREADME.md\n");
    assert.match(readFileSync(join(dir, "out", "diff.patch"), "utf8"), /\+token/);
    assert.equal(plan.security.run, true, "src/auth/** is a configured trigger");
    assert.equal(plan.cfg.model, "haiku");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runPlan refuses to invent a config it cannot find", () => {
  assert.throws(() => runPlan({ configPath: join(tmpdir(), "definitely-absent-flow-config.yml") }),
    (e) => e instanceof ReviewError && /not found/.test(e.message));
});

// ── verdicts (criterion 2, and the fail-closed rule) ──────────────────────────────────────

test("a PASS verdict with no findings passes", () => {
  const o = verdictOutcome(parseVerdict('{"verdict":"PASS","summary":"all four criteria proved"}'), { check: "qa" });
  assert.equal(o.ok, true);
  assert.equal(o.code, 0);
});

test("a fenced JSON verdict is read — models fence by habit", () => {
  const p = parseVerdict('```json\n{"verdict":"PASS"}\n```');
  assert.equal(p.verdict, "PASS");
});

// Criterion 2: an unproven acceptance criterion fails the qa check, and the check NAMES it.
test("qa FAILS and names each acceptance criterion that has no proving test", () => {
  const v = parseVerdict(JSON.stringify({
    verdict: "FAIL",
    unproven: ["Given a skipped security review, then the skip is visible"],
    summary: "1 of 7 criteria unproven",
  }));
  const o = verdictOutcome(v, { check: "qa" });
  assert.equal(o.ok, false);
  assert.equal(o.code, 1);
  assert.ok(o.lines.some((l) => l.includes("Given a skipped security review, then the skip is visible")),
    "a failure that does not name the criterion tells the worker nothing");
  assert.ok(o.lines.some((l) => /unproven criterion/.test(l)));
});

test("a reviewer cannot PASS while naming its own blocking evidence", () => {
  const unproven = verdictOutcome(parseVerdict('{"verdict":"PASS","unproven":["criterion 3"]}'), { check: "qa" });
  assert.equal(unproven.ok, false, "the letter grade does not overrule the evidence");

  const blocking = verdictOutcome(
    parseVerdict('{"verdict":"PASS","blocking":[{"file":"a.mjs","line":9,"issue":"unchecked input","fix":"validate"}]}'),
    { check: "code-review" },
  );
  assert.equal(blocking.ok, false);
  assert.ok(blocking.lines.some((l) => l.includes("a.mjs:9") && l.includes("unchecked input")),
    "a blocking finding must reach the log with its location and its fix");
});

test("a bare FAIL still produces a reason in the log", () => {
  const o = verdictOutcome(parseVerdict('{"verdict":"FAIL","summary":"scope creep"}'), { check: "code-review" });
  assert.equal(o.ok, false);
  assert.ok(o.lines.some((l) => /scope creep/.test(l)));
});

test("an empty, unparseable or verdict-less report throws rather than passing", () => {
  for (const bad of ["", "   ", "not json at all", "[]", '{"verdict":"MAYBE"}', "{}"]) {
    assert.throws(() => parseVerdict(bad), ReviewError,
      `${JSON.stringify(bad)} must not be readable as an approval`);
  }
});

test("CHECKS names the three gates that now run on the PR", () => {
  assert.deepEqual(CHECKS, ["qa", "code-review", "security"]);
});

// ── the CLI: the exit code is what actually blocks the PR ─────────────────────────────────

test("CLI `verdict` exits non-zero and names the unproven criterion", () => {
  const dir = tmp("cli-fail");
  try {
    const f = join(dir, "qa.json");
    writeFileSync(f, JSON.stringify({ verdict: "FAIL", unproven: ["Given X, when Y, then Z"] }));
    const summary = join(dir, "summary.md");
    const r = run(["verdict", f, "--check", "qa"], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });

    assert.equal(r.status, 1, "a failed review must fail the check, not merely comment on it");
    assert.match(r.stderr, /Given X, when Y, then Z/);
    assert.match(readFileSync(summary, "utf8"), /### qa review — FAIL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI `verdict` exits zero on a clean pass", () => {
  const dir = tmp("cli-pass");
  try {
    const f = join(dir, "code.json");
    writeFileSync(f, JSON.stringify({ verdict: "PASS", summary: "in scope, tested" }));
    const r = run(["verdict", f, "--check", "code-review"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-review: PASS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI `verdict` FAILS CLOSED when the reviewer wrote no verdict file at all", () => {
  const r = run(["verdict", join(tmpdir(), "no-such-verdict.json"), "--check", "security"]);
  assert.equal(r.status, 1, "a reviewer that died mid-run must not read as an approval");
  assert.match(r.stderr, /no verdict at/);
  assert.match(r.stderr, /has not approved/);
});

test("CLI rejects an unknown subcommand instead of exiting 0 having done nothing", () => {
  const r = run(["definitely-not-a-command"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected "plan" or "verdict"/);
});

// ── runReviewCli: the shell itself is exported, so an adapter never carries a copy of it ──
// Canonical's `.flow/bin/flow-review.mjs` invokes this function against its own store. Two
// copies of one shell is the flow-0008 hazard (see touches-guard.mjs), so the function has to
// hold the whole contract: it returns the exit code, it takes its defaults from `opts`, and the
// environment overrides still beat those defaults — the CI contract unchanged.

test("runReviewCli RETURNS the exit code instead of exiting — pass, fail, and fail-closed", () => {
  const dir = tmp("cli-fn");
  try {
    const f = join(dir, "qa.json");
    writeFileSync(f, JSON.stringify({ verdict: "PASS", summary: "ok" }));
    assert.equal(runReviewCli(["verdict", f, "--check", "qa"], { env: {} }), 0);
    writeFileSync(f, JSON.stringify({ verdict: "FAIL", summary: "nope" }));
    assert.equal(runReviewCli(["verdict", f, "--check", "qa"], { env: {} }), 1);
    assert.equal(runReviewCli(["verdict", join(dir, "absent.json")], { env: {} }), 1,
      "a missing verdict must fail through the function exactly as through the process");
    assert.equal(runReviewCli(["definitely-not-a-command"], { env: {} }), 1,
      "an unknown command returning 0 would be a gate that passes having done nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runReviewCli plan takes its defaults from opts — and the environment still wins", () => {
  const dir = tmp("cli-opts");
  try {
    writeFileSync(join(dir, "config.yml"), CONFIG);
    writeFileSync(join(dir, "override.yml"), `review:\n  model: "opus"\n`);
    const git = () => "";                       // an empty diff — the plan still has to complete
    const pinned = { configPath: join(dir, "config.yml"), outDir: join(dir, "outA"), git };

    assert.equal(runReviewCli(["plan"], { env: { GITHUB_OUTPUT: join(dir, "ghA") }, ...pinned }), 0);
    assert.match(readFileSync(join(dir, "ghA"), "utf8"), /^model=haiku$/m,
      "with no FLOW_CONFIG set, the pinned configPath is the config that is read");
    assert.ok(existsSync(join(dir, "outA", "diff.patch")) && existsSync(join(dir, "outA", "files.txt")),
      "the bounded context lands in the pinned outDir");

    const env = {
      FLOW_CONFIG: join(dir, "override.yml"),
      REVIEW_OUT_DIR: join(dir, "outB"),
      GITHUB_OUTPUT: join(dir, "ghB"),
    };
    assert.equal(runReviewCli(["plan"], { env, ...pinned }), 0);
    assert.match(readFileSync(join(dir, "ghB"), "utf8"), /^model=opus$/m,
      "FLOW_CONFIG must beat the pinned default — adapters change the default, never the contract");
    assert.ok(existsSync(join(dir, "outB", "diff.patch")), "and so must REVIEW_OUT_DIR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// End-to-end `plan` against a real git repo: proves the outputs the workflow reads are actually
// produced, including the model (criterion 5) and the visible security decision (criterion 3).
test("CLI `plan` publishes the model and the security decision as workflow outputs", () => {
  const dir = tmp("cli-plan");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(dir, ".flow"), { recursive: true });
    writeFileSync(join(dir, ".flow", "config.yml"), CONFIG);
    writeFileSync(join(dir, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    writeFileSync(join(dir, "README.md"), "changed\n");
    git("commit", "-aqm", "docs only");

    const out = join(dir, "gh-output");
    const summary = join(dir, "gh-summary");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    const r = run(["plan"], {
      cwd: dir,
      env: { ...process.env, BASE_REF: "main", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });

    assert.equal(r.status, 0, r.stderr);
    const outputs = readFileSync(out, "utf8");
    assert.match(outputs, /^model=haiku$/m, "the workflow reads the model from here — it names none itself");
    assert.match(outputs, /^security_model=opus$/m);
    assert.match(outputs, /^security_run=false$/m, "a docs-only diff touches no configured trigger path");
    assert.match(outputs, /^security_reason=SKIPPED — /m);
    assert.match(readFileSync(summary, "utf8"), /security review: \*\*SKIPPED\*\*/,
      "the skip has to be visible on the run, not just in an output variable");

    assert.match(readFileSync(join(dir, ".flow-review", "files.txt"), "utf8"), /^README\.md$/m);
    assert.match(readFileSync(join(dir, ".flow-review", "diff.patch"), "utf8"), /\+changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
