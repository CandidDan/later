// flow-kickback.test.mjs — proving tests for flow-0082.
//
// One section per exported decision: `decide`, `countRounds`, `weakensTests`, `decisionCard`,
// plus the CLI shell the workflow actually invokes. The acceptance criteria are the section
// headings, in order, so a reader can map a criterion to the case that proves it without
// reading the bodies.
//
// The guards here are deliberately conservative — `weakensTests` trips on a removed assertion
// even when the same edit adds a stronger one — so several cases below assert a FALSE POSITIVE
// is produced on purpose. That is the behaviour being bought: a false escalation costs a human
// one tap on a decision card; a weakening that slipped through costs a gate that lies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_FIXABLE_CHECKS,
  CARD_FALLBACK_TITLE,
  CARD_MAX_CHARS,
  CARD_TITLE,
  DISCLOSURE_MAX_LINE,
  DISCLOSURE_MAX_TRIPS,
  DISCLOSURE_TITLE,
  DISPATCH,
  ESCALATE,
  HARD_MAX_ROUNDS,
  MERGE_LINE,
  MESSAGE_SEPARATOR,
  NEEDS_HUMAN_LABEL,
  NOT_PUSHED_CHANGE,
  OUTCOME_DIR,
  OUTCOME_FILE,
  REVIEWABLE_STATUS,
  ROUND_TRAILER,
  SECURITY_CHECK,
  SKIP,
  cardFooter,
  cardFromOutcome,
  countRounds,
  criteriaAmended,
  criteriaSection,
  decide,
  decisionCard,
  disclosureComment,
  effectiveCap,
  fitFields,
  guardDecision,
  isTestPath,
  parseAutoFixRounds,
  parseOutcome,
  recommendationFor,
  roundNotPushed,
  roundTrailer,
  runKickbackCli,
  testLineBalance,
  trailerBlock,
  validateCard,
  weakensReport,
  weakensTests,
} from "./flow-kickback.mjs";

// Every condition holding at once. Each case below changes exactly one thing, so a failure
// names the condition rather than the fixture.
const GREEN = Object.freeze({
  failedChecks: ["code-review"],
  draft: false,
  fork: false,
  labels: [],
  taskId: "flow-0082",
  taskStatus: REVIEWABLE_STATUS,
  rounds: 0,
  configuredCap: 2,
  flowAi: "true",
  flowPat: "true",
});
const facts = (over = {}) => ({ ...GREEN, ...over });

const tmpDirs = [];
const withTmp = () => { const d = mkdtempSync(join(tmpdir(), "flow-kickback-")); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs.length = 0; });

const configWith = (line) => `project:\n  name: "x"\n\nreview:\n  model: "sonnet"\n${line}\n\ngit:\n  base_branch: "main"\n`;

// ═════════════════════════════════════════════════════════════════════════════════════════
// decide
// ═════════════════════════════════════════════════════════════════════════════════════════

test("every condition holds and code-review alone failed — dispatch", () => {
  const v = decide(facts());
  assert.equal(v.action, DISPATCH, v.reason);
  assert.equal(v.round, 1, "the first round is 1, not 0");
  assert.equal(v.cap, 2);
  assert.match(v.reason, /code-review failed/);
  assert.match(v.reason, /round 1\/2/);
});

test("qa and code-review both failed and all else holds — dispatch, naming both", () => {
  const v = decide(facts({ failedChecks: ["qa", "code-review"] }));
  assert.equal(v.action, DISPATCH, v.reason);
  assert.match(v.reason, /qa \+ code-review failed/);
  // A space-separated string is the shape the workflow hands over; it must decide identically.
  assert.deepEqual(decide(facts({ failedChecks: "qa code-review" })), v);
});

test("the security job failed, alone — escalate (security), never a dispatch", () => {
  const v = decide(facts({ failedChecks: [SECURITY_CHECK] }));
  assert.equal(v.action, ESCALATE);
  assert.match(v.reason, /security check failed/);
  assert.match(v.reason, /never auto-fixed/);
});

test("the security job failed alongside qa and code-review — still escalate (security)", () => {
  for (const failed of [["security", "qa"], ["qa", "security"], ["qa", "code-review", "security"]]) {
    const v = decide(facts({ failedChecks: failed }));
    assert.equal(v.action, ESCALATE, `${failed.join("+")} must escalate, not dispatch`);
    assert.match(v.reason, /security/);
  }
  assert.ok(!AUTO_FIXABLE_CHECKS.includes(SECURITY_CHECK),
    "security must never be on the auto-fixable list — the escalation above is the only route");
});

// One test per skip condition, each naming the condition in its reason (the criterion's words).
const SKIPS = [
  ["FLOW_AI is not 'true'", { flowAi: "false" }, /FLOW_AI/],
  ["FLOW_PAT is absent", { flowPat: "" }, /FLOW_PAT is absent/],
  ["the PR is from a fork", { fork: true }, /from a fork/],
  ["the PR is a draft", { draft: true }, /is a draft/],
  ["the PR carries flow:needs-human", { labels: [NEEDS_HUMAN_LABEL] }, /needs-human/],
  ["the task is not in_review", { taskStatus: "in_progress" }, /not 'in_review'/],
  ["no task id resolves", { taskId: "" }, /no task id resolves/],
];
for (const [name, over, reason] of SKIPS) {
  test(`skip: ${name}`, () => {
    const v = decide(facts(over));
    assert.equal(v.action, SKIP, `expected skip, got ${v.action}: ${v.reason}`);
    assert.match(v.reason, reason);
  });
}

test("the skip reason names the condition rather than restating the outcome", () => {
  for (const [, over] of SKIPS) {
    const { reason } = decide(facts(over));
    assert.ok(reason.length > 20, `"${reason}" is too short to name a condition`);
    assert.doesNotMatch(reason, /^skip\b/i, "the reason must explain, not repeat the verdict");
  }
});

test("review.auto_fix_rounds absent or 0 — skip, 'auto-fix off'", () => {
  for (const configuredCap of [null, undefined, "", 0, "0"]) {
    const v = decide(facts({ configuredCap }));
    assert.equal(v.action, SKIP, `cap ${JSON.stringify(configuredCap)} must be off`);
    assert.match(v.reason, /auto-fix off/);
    assert.equal(v.cap, 0);
  }
});

test("review.auto_fix_rounds: 5 — the effective cap is 3 and a warning names the configured 5", () => {
  const v = decide(facts({ configuredCap: 5 }));
  assert.equal(v.cap, HARD_MAX_ROUNDS);
  assert.equal(v.cap, 3);
  assert.equal(v.action, DISPATCH, v.reason);
  assert.match(v.warning, /configured as 5/);
  assert.match(v.warning, /maximum is 3/);
  assert.match(v.reason, /round 1\/3/);
});

test("a non-numeric review.auto_fix_rounds is OFF, with a warning naming the value", () => {
  const { cap, warning } = effectiveCap("lots");
  assert.equal(cap, 0);
  assert.match(warning, /"lots"/);
  assert.match(warning, /not a whole number/);
  assert.equal(effectiveCap(-1).cap, 0, "a negative round count is off, not unbounded");
  assert.equal(effectiveCap(null).warning, "", "an absent key is not a misconfiguration");
});

test("cap 2 with two stamped rounds — escalate (exhausted); with one — dispatch as round 2/2", () => {
  const stamped = (n) => `fix: address the finding\n\n${roundTrailer(n, 2)}`;
  const two = countRounds([stamped(1), stamped(2)]);
  assert.equal(two, 2);
  const exhausted = decide(facts({ rounds: two }));
  assert.equal(exhausted.action, ESCALATE);
  assert.match(exhausted.reason, /exhausted/);
  assert.match(exhausted.reason, /2 of 2/);

  const one = countRounds([stamped(1)]);
  assert.equal(one, 1);
  const second = decide(facts({ rounds: one }));
  assert.equal(second.action, DISPATCH, second.reason);
  assert.equal(second.round, 2);
  assert.match(second.reason, /round 2\/2/);
});

test("a round count past the cap still escalates rather than wrapping round to cap + 1", () => {
  const v = decide(facts({ rounds: 9, configuredCap: 2 }));
  assert.equal(v.action, ESCALATE);
  assert.match(v.reason, /exhausted/);
});

test("the checks are applied in the task's stated order — the first that applies decides", () => {
  // Every condition wrong at once: FLOW_AI wins, because it is check 1.
  const all = facts({
    flowAi: "false", configuredCap: 0, flowPat: "", fork: true, taskId: "",
    taskStatus: "ready", draft: true, labels: [NEEDS_HUMAN_LABEL], failedChecks: ["security"],
  });
  assert.match(decide(all).reason, /FLOW_AI/);
  assert.match(decide({ ...all, flowAi: "true" }).reason, /auto-fix off/);
  assert.match(decide({ ...all, flowAi: "true", configuredCap: 2 }).reason, /FLOW_PAT/);
  assert.match(decide({ ...all, flowAi: "true", configuredCap: 2, flowPat: "true" }).reason, /fork/);
  // Security beats the cap: a security failure at an exhausted cap escalates as security.
  assert.match(decide(facts({ failedChecks: ["security"], rounds: 2 })).reason, /security/);
});

test("a green review run that somehow reaches decide burns no round", () => {
  const v = decide(facts({ failedChecks: [] }));
  assert.equal(v.action, SKIP);
  assert.match(v.reason, /no auto-fixable check failed/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// countRounds
// ═════════════════════════════════════════════════════════════════════════════════════════

test("two messages carrying 1/2 and 2/2 in their trailer block — countRounds returns 2", () => {
  const messages = [
    "worker: implement the thing\n\nSome body text.\n",
    `fix: close the code-review finding\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${ROUND_TRAILER}: 1/2`,
    `fix: close the qa finding\n\n${ROUND_TRAILER}: 2/2\n`,
  ];
  assert.equal(countRounds(messages), 2);
});

test("a body mention, a malformed value and a bare trailer-only message are not counted", () => {
  const bodyMention = `fix: a thing\n\nWe will add ${ROUND_TRAILER}: 1/2 to the next commit.\n`;
  const malformed = `fix: a thing\n\n${ROUND_TRAILER}: round one of two`;
  const noSlash = `fix: a thing\n\n${ROUND_TRAILER}: 1`;
  const trailerOnly = `${ROUND_TRAILER}: 1/2`;
  assert.equal(countRounds([bodyMention, malformed, noSlash, trailerOnly]), 0);
  assert.deepEqual(trailerBlock(bodyMention), [], "a prose paragraph is not a trailer block");
  assert.equal(trailerBlock(malformed).length, 1, "it IS a trailer — the value is what is wrong");
});

test("no messages — countRounds returns 0, and a non-array is 0 rather than a throw", () => {
  assert.equal(countRounds([]), 0);
  assert.equal(countRounds(undefined), 0);
  assert.equal(countRounds("one message, not a list"), 0);
});

test("CRLF line endings and a trailing blank line do not hide a trailer", () => {
  assert.equal(countRounds([`fix: a thing\r\n\r\n${ROUND_TRAILER}: 1/3\r\n\r\n`]), 1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// weakensTests
// ═════════════════════════════════════════════════════════════════════════════════════════

const diff = (...lines) => lines.join("\n") + "\n";

test("a diff that only adds a new test and new assertions is clean", () => {
  const clean = diff(
    "diff --git a/src/thing.test.mjs b/src/thing.test.mjs",
    "--- a/src/thing.test.mjs",
    "+++ b/src/thing.test.mjs",
    "@@ -1,2 +1,6 @@",
    " import { test } from \"node:test\";",
    "+test(\"the new criterion holds\", () => {",
    "+  assert.equal(widen(1), 2);",
    "+  assert.deepEqual(widen([1]), [1, 2]);",
    "+});",
  );
  assert.deepEqual(weakensTests(clean), []);
  assert.equal(weakensReport(weakensTests(clean)), "");
});

test("a deleted test file trips, naming the file", () => {
  const deleted = diff(
    "diff --git a/src/thing.test.mjs b/src/thing.test.mjs",
    "deleted file mode 100644",
    "index 1234567..0000000",
    "--- a/src/thing.test.mjs",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-test(\"it holds\", () => {",
    "-  assert.ok(true);",
    "-});",
  );
  const offenders = weakensTests(deleted);
  assert.ok(offenders.length >= 1);
  assert.equal(offenders[0].file, "src/thing.test.mjs");
  assert.match(offenders[0].reason, /deleted/);
  assert.match(weakensReport(offenders), /src\/thing\.test\.mjs/);
});

test("a renamed test file trips, naming the file", () => {
  const renamed = diff(
    "diff --git a/src/thing.test.mjs b/src/thing.old.mjs",
    "similarity index 100%",
    "rename from src/thing.test.mjs",
    "rename to src/thing.old.mjs",
  );
  const offenders = weakensTests(renamed);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].reason, /renamed/);
  assert.match(weakensReport(offenders), /thing/);
});

test("a removed test(/it( declaration line trips", () => {
  for (const decl of ["test(\"a\", () => {", "it(\"b\", () => {", "describe(\"c\", () => {"]) {
    const offenders = weakensTests(diff(
      "diff --git a/x.test.mjs b/x.test.mjs",
      "@@ -1,1 +1,0 @@",
      `-${decl}`,
    ));
    assert.equal(offenders.length, 1, decl);
    assert.match(offenders[0].reason, /removed a test declaration/);
  }
});

test("replacing assert.deepEqual(x, [1, 2]) with assert.ok(x) trips as a removed assertion", () => {
  const loosened = diff(
    "diff --git a/x.test.mjs b/x.test.mjs",
    "@@ -3,1 +3,1 @@",
    "-  assert.deepEqual(x, [1, 2]);",
    "+  assert.ok(x);",
  );
  const offenders = weakensTests(loosened);
  assert.equal(offenders.length, 1, "the ADDED assertion does not excuse the removed one");
  assert.match(offenders[0].reason, /removed an assertion/);
  assert.match(offenders[0].line, /deepEqual/);
});

test("an added skip/only/todo marker in a test file trips", () => {
  for (const marker of ["  test(\"a\", { skip: true }, () => {", "  test.skip(\"a\", () => {", "  test.only(\"a\", () => {", "  todo: true,"]) {
    const offenders = weakensTests(diff(
      "diff --git a/x.test.mjs b/x.test.mjs",
      "@@ -1,0 +1,1 @@",
      `+${marker}`,
    ));
    assert.ok(offenders.length >= 1, `"${marker}" must trip`);
    assert.match(offenders.at(-1).reason, /skip\/only\/todo/);
  }
});

test("removing an assert line from a NON-test source file does not trip", () => {
  const source = diff(
    "diff --git a/src/thing.mjs b/src/thing.mjs",
    "@@ -1,2 +1,1 @@",
    "-import assert from \"node:assert\";",
    "-  assert.ok(ready);",
    "+  if (!ready) throw new Error(\"not ready\");",
  );
  assert.deepEqual(weakensTests(source), []);
});

test("a Python diff removing def test_ or an assert under tests/ trips", () => {
  const py = diff(
    "diff --git a/tests/test_thing.py b/tests/test_thing.py",
    "@@ -1,4 +1,2 @@",
    "-def test_widen_returns_two():",
    "-    assert widen(1) == 2",
    "+def helper():",
    "+    return 1",
  );
  const offenders = weakensTests(py);
  assert.equal(offenders.length, 2);
  assert.deepEqual(offenders.map((o) => o.reason), ["removed a test declaration", "removed an assertion"]);
  assert.equal(offenders[0].file, "tests/test_thing.py");
});

test("the test-file heuristic covers every convention the task names, and nothing else", () => {
  for (const p of ["a/b.test.mjs", "a/b.spec.ts", "a/b_test.go", "a/test_thing.py",
                   "test/helper.mjs", "tests/deep/helper.rb", "pkg/__tests__/x.js"]) {
    assert.ok(isTestPath(p), `${p} must read as a test path`);
  }
  for (const p of ["src/thing.mjs", "src/testing.mjs", "src/latest/thing.mjs", "contest/x.mjs", ""]) {
    assert.ok(!isTestPath(p), `${p} must NOT read as a test path`);
  }
});

test("an empty or absent diff is clean rather than a throw", () => {
  assert.deepEqual(weakensTests(""), []);
  assert.deepEqual(weakensTests(undefined), []);
});

test("each trip carries the line number it has in its own file — old file for a removal", () => {
  const offenders = weakensTests(diff(
    "diff --git a/x.test.mjs b/x.test.mjs",
    "@@ -10,3 +10,3 @@",
    " test(\"a\", () => {",
    "-  assert.equal(a, 1);",
    "+  assert.equal(a, 2);",
    " });",
  ));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].at, 11);
  assert.match(weakensReport(offenders), /x\.test\.mjs: removed an assertion \(line 11\) — assert\.equal\(a, 1\);/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// flow-0161 — the amended-criteria exception: criteriaAmended, guardDecision, disclosureComment
// ═════════════════════════════════════════════════════════════════════════════════════════

const taskFile = ({ status = "in_progress", notes = "first note", criterion = "then `tools` is undefined", ticked = false } = {}) => [
  "---",
  'id: "write-0090"',
  `status: "${status}"`,
  "notes:",
  `  - "${notes}"`,
  "---",
  "",
  "## Context",
  "",
  "Some context.",
  "",
  "## Acceptance criteria",
  "",
  `- [${ticked ? "x" : " "}] Given 8 tool rounds, when the route runs, ${criterion}.`,
  "- [ ] Given a short reply, when it streams, then it renders.",
  "",
  "## Definition of done (inherited — do not edit)",
  "",
  "Every criterion has a proving test.",
  "",
].join("\n");

test("flow-0161 criterion 1: a reworded criterion reads as amended", () => {
  const base = taskFile();
  const amended = taskFile({ criterion: "then the tools stay declared and `tool_choice` is `none`" });
  assert.equal(criteriaAmended(base, amended), true);
});

test("flow-0161 criterion 1: texts that differ only outside the criteria section read as not amended", () => {
  const base = taskFile();
  assert.equal(criteriaAmended(base, taskFile({ status: "in_review" })), false, "status is not the contract");
  assert.equal(criteriaAmended(base, taskFile({ notes: "a later note" })), false, "notes are not the contract");
  assert.equal(criteriaAmended(base, base.replace("Some context.", "Rewritten context.")), false, "## Context is not the contract");
  assert.equal(criteriaAmended(base, base.replace("Every criterion has a proving test.", "Changed.")), false,
    "the next ## heading ends the section");
  assert.equal(criteriaAmended(base, base), false);
});

test("flow-0161: whitespace, CRLF and a ticked checkbox are not amendments", () => {
  const base = taskFile();
  assert.equal(criteriaAmended(base, base.replace(/\n/g, "\r\n")), false);
  assert.equal(criteriaAmended(base, base.replace("## Acceptance criteria\n", "## Acceptance criteria\n\n\n")), false);
  assert.equal(criteriaAmended(base, base.replace("it renders.", "it renders.   ")), false);
  assert.equal(criteriaAmended(base, taskFile({ ticked: true })), false);
});

test("flow-0161: a missing file or section on either side is never an amendment", () => {
  const base = taskFile();
  const noSection = base.replace("## Acceptance criteria", "## Something else");
  assert.equal(criteriaSection(noSection), null);
  assert.equal(criteriaAmended("", base), false, "absent at the merge base");
  assert.equal(criteriaAmended(base, ""), false, "absent on the default branch");
  assert.equal(criteriaAmended(noSection, base), false);
  assert.equal(criteriaAmended(base, noSection), false);
  assert.equal(criteriaAmended(undefined, undefined), false);
});

test("flow-0161: a heading-shaped line inside the frontmatter cannot pose as the section", () => {
  const base = taskFile();
  const posing = base.replace('  - "first note"', '  - "first note"\n## Acceptance criteria\n- [ ] anything');
  assert.equal(criteriaSection(posing), criteriaSection(base));
  assert.equal(criteriaAmended(base, posing), false);
});

// The write#183 shape: one test that asserted the old criterion replaced by one asserting the new.
const REPLACEMENT = diff(
  "diff --git a/src/route.mjs b/src/route.mjs",
  "@@ -40,1 +40,1 @@",
  "-  const tools = rounds >= 8 ? undefined : TOOLS;",
  "+  const toolChoice = rounds >= 8 ? { type: \"none\" } : undefined;",
  "diff --git a/src/route.test.mjs b/src/route.test.mjs",
  "@@ -20,4 +20,4 @@",
  "-test(\"at 8 rounds the route declares no tools\", () => {",
  "-  assert.equal(body(8).tools, undefined);",
  "+test(\"at 8 rounds the route keeps the tools and sends tool_choice none\", () => {",
  "+  assert.deepEqual(body(8).tool_choice, { type: \"none\" });",
  " });",
);

test("flow-0161 criterion 2: a replaced test and assertion, with the criteria amended, is kept and disclosed", () => {
  const verdict = guardDecision({ diff: REPLACEMENT, amended: true });
  assert.equal(verdict.discard, false, "the round is NOT discarded");
  assert.deepEqual(verdict.disclose.map((o) => o.reason), ["removed a test declaration", "removed an assertion"]);
  assert.ok(verdict.disclose.every((o) => o.file === "src/route.test.mjs"));
  assert.deepEqual(verdict.disclose.map((o) => o.at), [20, 21], "each trip names its line");
  assert.deepEqual(verdict.disclose, weakensTests(REPLACEMENT), "every trip is returned, none filtered out");
  assert.match(verdict.reason, /amended/);
});

test("flow-0161 criterion 3: the same diff with the criteria NOT amended is discarded exactly as today", () => {
  const verdict = guardDecision({ diff: REPLACEMENT, amended: false });
  assert.equal(verdict.discard, true);
  assert.deepEqual(verdict.offenders, weakensTests(REPLACEMENT));
  assert.deepEqual(verdict.disclose, []);
  // Only the boolean `true` relaxes the guard — never a string or a truthy-looking value.
  for (const amended of ["true", 1, "yes", undefined, null]) {
    assert.equal(guardDecision({ diff: REPLACEMENT, amended }).discard, true, `amended=${String(amended)}`);
  }
});

test("flow-0161 criterion 4: a deleted test file is still discarded with the criteria amended", () => {
  const deleted = diff(
    "diff --git a/src/route.test.mjs b/src/route.test.mjs",
    "deleted file mode 100644",
    "--- a/src/route.test.mjs",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-test(\"at 8 rounds the route declares no tools\", () => {",
    "-  assert.equal(body(8).tools, undefined);",
    "-});",
    "diff --git a/src/route2.test.mjs b/src/route2.test.mjs",
    "@@ -1,0 +1,3 @@",
    "+test(\"a replacement elsewhere\", () => {",
    "+  assert.ok(true);",
    "+});",
  );
  const verdict = guardDecision({ diff: deleted, amended: true });
  assert.equal(verdict.discard, true);
  assert.deepEqual(verdict.disclose, []);
  assert.ok(verdict.offenders.some((o) => o.reason === "test file deleted"));
});

test("flow-0161 criterion 4: removing more test declarations than it adds is still discarded with the criteria amended", () => {
  const netLoss = diff(
    "diff --git a/src/route.test.mjs b/src/route.test.mjs",
    "@@ -20,8 +20,4 @@",
    "-test(\"at 8 rounds the route declares no tools\", () => {",
    "-  assert.equal(body(8).tools, undefined);",
    "-});",
    "-test(\"at 9 rounds too\", () => {",
    "-  assert.equal(body(9).tools, undefined);",
    "+test(\"at 8 rounds the route sends tool_choice none\", () => {",
    "+  assert.deepEqual(body(8).tool_choice, { type: \"none\" });",
    "+  assert.deepEqual(body(9).tool_choice, { type: \"none\" });",
    " });",
  );
  const verdict = guardDecision({ diff: netLoss, amended: true });
  assert.equal(verdict.discard, true);
  assert.deepEqual(verdict.disclose, []);
  const loss = verdict.offenders.filter((o) => o.reason === "net loss of test declarations");
  assert.equal(loss.length, 1);
  assert.equal(loss[0].file, "src/route.test.mjs");
  assert.match(loss[0].line, /2 removed, 1 added/);
  assert.deepEqual(testLineBalance(netLoss), {
    "src/route.test.mjs": { declRemoved: 2, declAdded: 1, assertRemoved: 2, assertAdded: 2 },
  });
});

test("flow-0161: a net loss of assertions, an added skip, or a replacement in ANOTHER file is still discarded", () => {
  const fewerAsserts = diff(
    "diff --git a/x.test.mjs b/x.test.mjs",
    "@@ -1,2 +1,1 @@",
    "-  assert.equal(a, 1);",
    "-  assert.equal(b, 2);",
    "+  assert.equal(a, 3);",
  );
  assert.equal(guardDecision({ diff: fewerAsserts, amended: true }).discard, true);
  assert.ok(guardDecision({ diff: fewerAsserts, amended: true }).offenders.some((o) => o.reason === "net loss of assertions"));

  const skipped = diff(
    "diff --git a/x.test.mjs b/x.test.mjs",
    "@@ -1,1 +1,1 @@",
    "-test(\"a\", () => {",
    "+test.skip(\"a\", () => {",
  );
  assert.equal(guardDecision({ diff: skipped, amended: true }).discard, true);

  const renamed = diff(
    "diff --git a/x.test.mjs b/x.old.mjs",
    "rename from x.test.mjs",
    "rename to x.old.mjs",
  );
  assert.equal(guardDecision({ diff: renamed, amended: true }).discard, true);

  const moved = diff(
    "diff --git a/a.test.mjs b/a.test.mjs",
    "@@ -1,1 +1,0 @@",
    "-  assert.equal(a, 1);",
    "diff --git a/b.test.mjs b/b.test.mjs",
    "@@ -1,0 +1,1 @@",
    "+  assert.equal(a, 2);",
  );
  assert.equal(guardDecision({ diff: moved, amended: true }).discard, true, "the balance is per file");
});

test("flow-0161: a clean diff is kept with nothing to disclose, amended or not", () => {
  const clean = diff("diff --git a/src/x.mjs b/src/x.mjs", "@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 2;");
  for (const amended of [true, false]) {
    const verdict = guardDecision({ diff: clean, amended });
    assert.equal(verdict.discard, false);
    assert.deepEqual(verdict.disclose, []);
  }
  assert.equal(guardDecision().discard, false);
});

test("flow-0161: the disclosure comment lists every trip — file, line and reason — fenced so it cannot render or mention", () => {
  const trips = weakensTests(REPLACEMENT);
  const comment = disclosureComment(trips, { round: "1", cap: "2" });
  assert.ok(comment.startsWith(DISCLOSURE_TITLE), "headed, so a reviewer sees it before the re-run");
  assert.match(comment, /round 1 of 2/);
  assert.match(comment, /amended/);
  for (const t of trips) {
    assert.ok(comment.includes(`${t.file}: ${t.reason} (line ${t.at}) — ${t.line}`), `${t.reason} is listed`);
  }
  // A trip line carrying backticks and an @-mention stays inside a longer fence.
  const hostile = [{ file: "x.test.mjs", at: 3, reason: "removed an assertion", line: "assert.ok(```@someone```)" }];
  const fenced = disclosureComment(hostile);
  assert.ok(fenced.includes("````\n"), "the fence outgrows the longest backtick run");
  assert.match(fenced, /round \? of \?/);
});

test("flow-0161: the disclosure comment is bounded, and says how many it left out", () => {
  const many = Array.from({ length: DISCLOSURE_MAX_TRIPS + 5 }, (_, n) =>
    ({ file: "x.test.mjs", at: n + 1, reason: "removed an assertion", line: `assert.equal(a, ${n});` }));
  const comment = disclosureComment(many, { round: "2", cap: "2" });
  assert.equal((comment.match(/removed an assertion/g) ?? []).length, DISCLOSURE_MAX_TRIPS);
  assert.match(comment, /and 5 more/);
  const long = disclosureComment([{ file: "x.test.mjs", at: 1, reason: "removed an assertion", line: "a".repeat(5000) }]);
  assert.ok(!long.includes("a".repeat(DISCLOSURE_MAX_LINE)), "one model-written line cannot blow the bound");
  assert.ok(long.includes(`${"a".repeat(DISCLOSURE_MAX_LINE - 1)}…`));
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// decisionCard
// ═════════════════════════════════════════════════════════════════════════════════════════

const CARD = Object.freeze({
  check: "code-review",
  finding: "flow-sync.mjs splits on \\n, so a CRLF checkout yields paths with a trailing \\r.",
  tried: "Switched the split to /\\r?\\n/ and added a CRLF fixture to the sync test.",
  recommendation: { action: "kickback", change: "split on /\\r?\\n/ in flow-sync.mjs, with a CRLF fixture" },
  alternative: "Merge as is and fix CRLF in a follow-on — costs one more red review on the next sync PR.",
  link: "https://github.com/CandidDan/flow/pull/108#issuecomment-1",
  rounds: 1,
  cap: 2,
});

test("all four fields with a kickback recommendation — the card renders every part", () => {
  const card = decisionCard(CARD);
  assert.ok(card.startsWith(CARD_TITLE), card.slice(0, 80));
  assert.match(card, /\*\*Finding\*\* \(`code-review`\)/);
  assert.ok(card.includes(CARD.finding), "the finding itself must be in the card");
  assert.match(card, /\*\*Tried \/ disputed:\*\*/);
  assert.ok(card.includes(CARD.tried));
  assert.match(card, /\*\*Recommendation:\*\* kick back with: split on/);
  assert.match(card, /\*\*Alternative:\*\*/);
  assert.ok(card.includes(CARD.alternative));
  assert.match(card, /Auto-fix rounds used: 1\/2/);
  assert.match(card, new RegExp(`re-arm by removing the \`${NEEDS_HUMAN_LABEL}\` label`));
  assert.ok(card.includes(CARD.link), "the card links to the reviewer's own comment");
  assert.ok(card.length <= CARD_MAX_CHARS);
});

test("a merge recommendation says 'merge as is' and never names a change", () => {
  const card = decisionCard({ ...CARD, recommendation: { action: "merge" } });
  assert.match(card, new RegExp(`\\*\\*Recommendation:\\*\\* ${MERGE_LINE}`));
  assert.ok(!card.includes("kick back with:"));
});

test("input missing any field, or kickback with an empty change, renders the fallback card", () => {
  const broken = [
    ["no finding", { ...CARD, finding: "" }, /`finding` is missing/],
    ["no tried", { ...CARD, tried: "   " }, /`tried` is missing/],
    ["no alternative", { ...CARD, alternative: undefined }, /`alternative` is missing/],
    ["no recommendation", { ...CARD, recommendation: undefined }, /`recommendation.action` must be/],
    ["a bogus action", { ...CARD, recommendation: { action: "ship it" } }, /must be exactly/],
    ["kickback, empty change", { ...CARD, recommendation: { action: "kickback", change: " " } }, /names no change/],
  ];
  for (const [name, input, why] of broken) {
    const card = decisionCard(input);
    assert.ok(card.startsWith(CARD_FALLBACK_TITLE), `${name}: expected the fallback card`);
    assert.match(card, /recommendation unavailable/i, name);
    assert.match(card, why, name);
    assert.ok(card.includes(CARD.link), `${name}: the fallback still carries the link`);
    assert.ok(card.length <= CARD_MAX_CHARS, name);
  }
  // The finding survives into the fallback whenever there is one to carry.
  assert.ok(decisionCard({ ...CARD, recommendation: undefined }).includes(CARD.finding));
  // And when there is not, the card says so rather than rendering a blank line.
  assert.match(decisionCard({ link: CARD.link }), /not captured/);
});

test("fields long enough to exceed the budget are cut, and the card still links to the source", () => {
  const long = (n) => "x".repeat(n);
  const card = decisionCard({
    ...CARD,
    finding: long(4000),
    tried: long(4000),
    alternative: long(4000),
    recommendation: { action: "kickback", change: long(4000) },
  });
  assert.ok(card.length <= CARD_MAX_CHARS, `card is ${card.length} characters`);
  assert.match(card, /…/, "a cut field is marked as cut, not silently truncated");
  assert.ok(card.includes(CARD.link), "a cut card must link to the full reviewer comment");
  assert.match(card, /Auto-fix rounds used: 1\/2/, "the footer survives the cut");
  // The fallback card obeys the same budget on an over-long finding.
  assert.ok(decisionCard({ ...CARD, finding: long(9000), recommendation: undefined }).length <= CARD_MAX_CHARS);
});

test("fitFields allocates max-min fairly — a long field never starves a short one", () => {
  const out = fitFields({ a: "short", b: "y".repeat(500) }, 100);
  assert.equal(out.a, "short", "a field that fits is never cut");
  assert.ok(out.b.length <= 95);
  assert.ok(out.a.length + out.b.length <= 100);
  assert.deepEqual(fitFields({ a: "abc" }, 0), { a: "" }, "a zero budget renders nothing, not a throw");
});

test("validateCard names every problem it found, not only the first", () => {
  const { ok, problems } = validateCard({});
  assert.equal(ok, false);
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.deepEqual(validateCard(CARD), { ok: true, problems: [] });
});

test("cardFooter carries the rounds, the link and the re-arm instruction in one line", () => {
  const line = cardFooter(2, 3, "https://example.test/c#1");
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /2\/3/);
  assert.match(line, /https:\/\/example\.test/);
  assert.match(line, /re-arm/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The hand-back file, and the card built from it
// ═════════════════════════════════════════════════════════════════════════════════════════

test("parseOutcome accepts fixed and disputed and reports anything else rather than throwing", () => {
  assert.equal(parseOutcome(JSON.stringify({ outcome: "fixed" })).outcome, "fixed");
  assert.equal(parseOutcome(JSON.stringify({ outcome: "disputed" })).outcome, "disputed");
  assert.match(parseOutcome("{nope").reason, /not valid JSON/);
  assert.match(parseOutcome("[1]").reason, /not a JSON object/);
  assert.match(parseOutcome(JSON.stringify({ outcome: "done" })).reason, /no known outcome/);
  assert.equal(parseOutcome("{nope").ok, false);
});

test("a disputed round's card comes from the worker's own hand-back, amended with the guard's reason", () => {
  const handBack = {
    outcome: "disputed",
    finding: "code-review says the regex is anchored wrongly.",
    tried: "Nothing — the anchor is correct; the reviewer read the test fixture, not the source.",
    recommendation: { action: "merge" },
    alternative: "Kick back and re-anchor — would make the regex wrong to satisfy a misread.",
  };
  const card = decisionCard(cardFromOutcome(handBack, {
    amend: "The round disputed the finding.", check: "code-review", link: "https://x.test/1", rounds: 1, cap: 2,
  }));
  assert.match(card, /The round disputed the finding\./);
  assert.ok(card.includes(handBack.tried), "the worker's own words survive the amendment");
  assert.match(card, new RegExp(MERGE_LINE));
  assert.ok(card.includes(handBack.finding));
});

test("a hand-back the guard stopped keeps the worker's fields and leads with the guard's verdict", () => {
  const input = cardFromOutcome({ outcome: "fixed", finding: "F", tried: "Rewrote the assertion.", recommendation: { action: "kickback", change: "C" }, alternative: "A" },
    { amend: "BLOCKED: the round removed an assertion.", rounds: 1, cap: 2, link: "https://x.test/1" });
  assert.ok(input.tried.startsWith("BLOCKED: the round removed an assertion."),
    "the guard's verdict must never be buried under the worker's account of itself");
  assert.ok(input.tried.includes("Rewrote the assertion."));
  assert.ok(decisionCard(input).startsWith(CARD_TITLE));
});

test("no hand-back at all still produces a card — the fallback one", () => {
  for (const data of [null, undefined, [], "text"]) {
    const card = decisionCard(cardFromOutcome(data, { link: "https://x.test/1", rounds: 1, cap: 2 }));
    assert.ok(card.startsWith(CARD_FALLBACK_TITLE), `${JSON.stringify(data)} must fall back`);
    assert.ok(card.includes("https://x.test/1"));
  }
});

// The dead-round path, which is the ONE the `if: always()` backstop exists for: the round
// crashed, timed out, or handed back nothing usable, so there is no `finding` and no
// `recommendation` and the card is necessarily the fallback one. `cardFromOutcome` puts the
// guard's own sentence into `tried`, so a fallback that rendered only `finding` would post a
// card reading "Finding: not captured" and drop the only fact the workflow actually had —
// WHICH check fired. Each of the four guards' real sentences is asserted here by text.
test("a round with NO usable hand-back still shows the guard's own amend text on the card", () => {
  const amends = [
    "The round ended without writing a hand-back, so there is no account of what it did.",
    "The round's hand-back named no known outcome, so nothing about the round can be trusted.",
    "The round WEAKENED THE TESTS — it removed a test or an assertion. The change was thrown away, not pushed.",
    "The round ended without completing, and left no reason.",
  ];
  for (const amend of amends) {
    for (const data of [null, undefined, [], "text", { outcome: "fixed" }]) {
      const card = decisionCard(cardFromOutcome(data, {
        amend, check: "qa", link: "https://x.test/1", rounds: 1, cap: 2,
      }));
      const why = `${amend.slice(0, 24)}… / ${JSON.stringify(data)}`;
      assert.ok(card.startsWith(CARD_FALLBACK_TITLE), `${why}: must fall back`);
      assert.match(card, /\*\*Tried \/ disputed:\*\*/, `${why}: the fallback must render the tried line`);
      assert.ok(card.includes(amend), `${why}: the guard's sentence must reach the human`);
      assert.ok(card.includes("https://x.test/1"), `${why}: the link survives`);
      assert.match(card, /Auto-fix rounds used: 1\/2/, `${why}: the footer survives`);
      assert.ok(card.length <= CARD_MAX_CHARS, `${why}: card is ${card.length} characters`);
    }
  }
  // An over-long amend is cut to the budget rather than blowing it, same as every other field.
  const long = decisionCard(cardFromOutcome(null, { amend: "z".repeat(9000), link: "https://x.test/1" }));
  assert.ok(long.length <= CARD_MAX_CHARS, `card is ${long.length} characters`);
  assert.match(long, /…/, "a cut amend is marked as cut, not silently truncated");
  // And with no amend and no hand-back there is nothing to say, so the card says that outright
  // instead of rendering a blank line under the label.
  const silent = decisionCard(cardFromOutcome(null, { link: "https://x.test/1" }));
  assert.match(silent, /\*\*Tried \/ disputed:\*\* not captured/);
});

// ── flow-0160: a round whose change was thrown away never recommends merging ─────────────────
//
// CandidDan/write#183: the round fixed the bug, `check-weakens` threw the commit away, and the
// card still said "merge as is" — the hand-back was written before the guard ran and assumed its
// commit would be pushed. Each of the four push-side guards' real sentences is asserted here.
const PUSH_SIDE_AMENDS = Object.freeze({
  "check-remote-head": "The remote branch moved during the round, so either the fixer pushed despite the limit or a human did. Nothing was pushed by this round.",
  "check-bundle": "The round's commits did not arrive as a bundle based on this PR's recorded head (0123abc). Nothing was pushed.",
  "check-weakens": "The round WEAKENED THE TESTS — it removed a test or an assertion. The change was thrown away, not pushed.",
  "check-commits": "The round reported a fix and committed nothing, so the finding is still open.",
});
const MERGE_HANDBACK = Object.freeze({
  outcome: "fixed",
  finding: "qa: the parser drops the last line.",
  tried: "Kept the last line and added a test for it.",
  recommendation: { action: "merge" },
  alternative: "kick back and rewrite the parser",
});
const recOf = (card) => card.split("**Recommendation:** ")[1].split("\n\n")[0];

test("flow-0160: a merge hand-back whose push guard set an amend becomes a kickback saying the head is unchanged", () => {
  for (const [guard, amend] of Object.entries(PUSH_SIDE_AMENDS)) {
    const input = cardFromOutcome(MERGE_HANDBACK, {
      amend, check: "qa", link: "https://x.test/1", rounds: 1, cap: 2, pushed: false, outcome: "fixed",
    });
    assert.equal(input.recommendation.action, "kickback", `${guard}: nothing was pushed, so merge is wrong`);
    assert.equal(input.recommendation.change, NOT_PUSHED_CHANGE, `${guard}`);
    const card = decisionCard(input);
    assert.ok(card.startsWith(CARD_TITLE), `${guard}: still a full card, not the fallback`);
    assert.equal(recOf(card), `kick back with: ${NOT_PUSHED_CHANGE}`, `${guard}`);
    assert.match(recOf(card), /PR head is unchanged/, `${guard}: the card says the head did not move`);
    assert.ok(!recOf(card).includes(MERGE_LINE), `${guard}: never "merge as is"`);
    assert.ok(card.includes(amend), `${guard}: the guard's sentence still leads Tried`);
    assert.ok(card.includes(`**Alternative:** ${MERGE_HANDBACK.alternative}`), `${guard}: the alternative is kept`);
    // An amend alone is enough: `push` cannot have pushed past a guard that wrote one.
    assert.equal(cardFromOutcome(MERGE_HANDBACK, { amend, pushed: true, outcome: "fixed" }).recommendation.action,
      "kickback", `${guard}: an amend means nothing was pushed, whatever the flag says`);
  }
  // The fixer's own change text may follow the sentence, never as a merge.
  const withChange = recommendationFor({ action: "merge", change: "then drop the trailing newline" },
    { pushed: false, outcome: "fixed" });
  assert.deepEqual(withChange, { action: "kickback", change: `${NOT_PUSHED_CHANGE} then drop the trailing newline` });
  // A `push` that died with no amend at all (`pushed` false, nothing else known) is the same fact.
  assert.equal(recommendationFor({ action: "merge" }, { pushed: false }).action, "kickback");
  // A dead round described by `round-card` writes `"outcome": "disputed"` into the hand-back, but
  // `push`'s own reading is what counts — `none` is not a dispute.
  assert.equal(cardFromOutcome({ ...MERGE_HANDBACK, outcome: "disputed" }, { pushed: false, outcome: "none" })
    .recommendation.action, "kickback");
  // A kickback the fixer already recommended is left alone, and so is a recommendation the card
  // must reject — the fallback card still says nothing was pushed.
  const kick = { action: "kickback", change: "C" };
  assert.equal(recommendationFor(kick, { pushed: false, outcome: "fixed" }), kick);
  assert.equal(recommendationFor(undefined, { pushed: false }), undefined);
  assert.equal(recommendationFor("merge", { pushed: false }), "merge");
});

test("flow-0160: a pushed round, and a card that describes no round, keep today's recommendation byte for byte", () => {
  const today = decisionCard(cardFromOutcome(MERGE_HANDBACK, { check: "qa", link: "https://x.test/1", rounds: 1, cap: 2 }));
  const pushed = decisionCard(cardFromOutcome(MERGE_HANDBACK, {
    check: "qa", link: "https://x.test/1", rounds: 1, cap: 2, pushed: true, outcome: "fixed",
  }));
  assert.equal(pushed, today);
  assert.equal(recOf(pushed), MERGE_LINE);
  assert.equal(cardFromOutcome(MERGE_HANDBACK, { pushed: true, amend: "" }).recommendation, MERGE_HANDBACK.recommendation);
  // `plan`'s own escalations carry their reason as the amend and describe no round: unchanged.
  assert.equal(recOf(decisionCard(cardFromOutcome(MERGE_HANDBACK, { amend: "the security check failed" }))), MERGE_LINE);
  assert.equal(roundNotPushed({ amend: "anything" }), false);
  assert.equal(roundNotPushed({ pushed: null, amend: "anything" }), false);
  assert.equal(roundNotPushed({ pushed: true }), false);
  assert.equal(roundNotPushed({ pushed: false }), true);
  assert.equal(roundNotPushed(), false);
});

test("flow-0160: a disputed round's recommendation is unchanged — it pushes nothing by design", () => {
  const disputed = { ...MERGE_HANDBACK, outcome: "disputed", tried: "Nothing — the finding misreads the fixture." };
  const amend = "The round DISPUTED the finding and changed no code for it.";
  const today = decisionCard(cardFromOutcome(disputed, { amend, check: "qa", link: "https://x.test/1", rounds: 1, cap: 2 }));
  const now = decisionCard(cardFromOutcome(disputed, {
    amend, check: "qa", link: "https://x.test/1", rounds: 1, cap: 2, pushed: false, outcome: "disputed",
  }));
  assert.equal(now, today);
  assert.equal(recOf(now), MERGE_LINE);
  const kick = { action: "kickback", change: "C" };
  assert.equal(recommendationFor(kick, { pushed: false, amend, outcome: "disputed" }), kick);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// review.auto_fix_rounds, read from .flow/config.yml
// ═════════════════════════════════════════════════════════════════════════════════════════

test("parseAutoFixRounds reads the key from the review block, comments and quotes included", () => {
  assert.equal(parseAutoFixRounds(configWith("  auto_fix_rounds: 2")), "2");
  assert.equal(parseAutoFixRounds(configWith("  auto_fix_rounds: 2   # two rounds, then a human")), "2");
  assert.equal(parseAutoFixRounds(configWith('  auto_fix_rounds: "3"')), "3");
});

test("a commented-out or absent key reads as null — the off-by-default shape the template ships", () => {
  assert.equal(parseAutoFixRounds(configWith("  # auto_fix_rounds: 2")), null);
  assert.equal(parseAutoFixRounds("project:\n  name: \"x\"\n"), null, "no review block at all");
  assert.equal(parseAutoFixRounds(configWith("  security_model: \"opus\"")), null);
  // A key of the same name OUTSIDE the review block is not review.auto_fix_rounds.
  assert.equal(parseAutoFixRounds("auto_fix_rounds: 3\n\nreview:\n  model: \"sonnet\"\n"), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The CLI the workflow invokes
// ═════════════════════════════════════════════════════════════════════════════════════════

const capture = () => { const buf = []; return { write: (s) => buf.push(s), text: () => buf.join("") }; };

test("`decide` writes the verdict to GITHUB_OUTPUT and prints the reason", () => {
  const dir = withTmp();
  const config = join(dir, "config.yml");
  const commits = join(dir, "commits.txt");
  const output = join(dir, "out.txt");
  writeFileSync(config, configWith("  auto_fix_rounds: 2"));
  writeFileSync(commits, [`fix: one\n\n${roundTrailer(1, 2)}`, "worker: implement\n\nbody"].join(MESSAGE_SEPARATOR));
  writeFileSync(output, "");

  const out = capture();
  const code = runKickbackCli(["decide"], {
    stdout: out.write,
    stderr: () => {},
    env: {
      GITHUB_OUTPUT: output, FLOW_CONFIG: config, KICKBACK_COMMITS_FILE: commits,
      FLOW_AI: "true", KICKBACK_HAS_PAT: "true", KICKBACK_FAILED_CHECKS: "qa",
      KICKBACK_DRAFT: "false", KICKBACK_FORK: "false", KICKBACK_LABELS: "",
      KICKBACK_TASK_ID: "flow-0082", KICKBACK_TASK_STATUS: REVIEWABLE_STATUS,
    },
  });
  assert.equal(code, 0);
  const written = readFileSync(output, "utf8");
  assert.match(written, /^action<<FLOW_EOF\ndispatch\nFLOW_EOF$/m);
  assert.match(written, /^round<<FLOW_EOF\n2\nFLOW_EOF$/m);
  assert.match(written, /^rounds_used<<FLOW_EOF\n1\nFLOW_EOF$/m);
  assert.match(written, /^cap<<FLOW_EOF\n2\nFLOW_EOF$/m);
  assert.match(written, new RegExp(`^trailer<<FLOW_EOF\\n${ROUND_TRAILER}: 2/2\\nFLOW_EOF$`, "m"));
  assert.match(out.text(), /^dispatch: qa failed/);
});

test("`decide` with no config and no commits file skips, and emits nothing when GITHUB_OUTPUT is unset", () => {
  const out = capture();
  assert.equal(runKickbackCli(["decide"], { stdout: out.write, stderr: () => {}, env: { FLOW_AI: "true" } }), 0);
  assert.match(out.text(), /^skip: auto-fix off/);
});

test("`decide` surfaces the clamp warning on stderr as a workflow warning", () => {
  const dir = withTmp();
  const config = join(dir, "config.yml");
  writeFileSync(config, configWith("  auto_fix_rounds: 9"));
  const err = capture();
  runKickbackCli(["decide"], {
    stdout: () => {}, stderr: err.write,
    env: {
      FLOW_CONFIG: config, FLOW_AI: "true", KICKBACK_HAS_PAT: "true",
      KICKBACK_FAILED_CHECKS: "qa", KICKBACK_TASK_ID: "flow-0082", KICKBACK_TASK_STATUS: REVIEWABLE_STATUS,
    },
  });
  assert.match(err.text(), /^::warning::.*configured as 9/);
});

test("`rounds` counts NUL-delimited commit messages from a file", () => {
  const dir = withTmp();
  const file = join(dir, "commits.txt");
  writeFileSync(file, [
    `fix: one\n\nA body paragraph.\n\n${roundTrailer(1, 3)}`,
    `fix: two\n\n${roundTrailer(2, 3)}`,
    "worker: implement the task\n\nNo trailer here.",
  ].join(MESSAGE_SEPARATOR));
  const out = capture();
  assert.equal(runKickbackCli(["rounds", file], { stdout: out.write, env: {} }), 0);
  assert.equal(out.text().trim(), "2");
});

test("`weakens` exits 1 and names the offender on a weakening diff, 0 on a clean one", () => {
  const dir = withTmp();
  const bad = join(dir, "bad.diff");
  const good = join(dir, "good.diff");
  writeFileSync(bad, diff("diff --git a/x.test.mjs b/x.test.mjs", "@@ -1,1 +1,1 @@", "-  assert.equal(a, 1);", "+  assert.ok(a);"));
  writeFileSync(good, diff("diff --git a/src/x.mjs b/src/x.mjs", "@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 2;"));

  const bo = capture();
  assert.equal(runKickbackCli(["weakens", bad], { stdout: bo.write, env: {} }), 1);
  assert.match(bo.text(), /x\.test\.mjs: removed an assertion/);

  const go = capture();
  assert.equal(runKickbackCli(["weakens", good], { stdout: go.write, env: {} }), 0);
  assert.match(go.text(), /clean/);
});

test("flow-0161: `amended` writes amended=true|false to GITHUB_OUTPUT, and an unreadable side is false", () => {
  const dir = withTmp();
  const base = join(dir, "base.md");
  const head = join(dir, "default.md");
  const output = join(dir, "output.txt");
  writeFileSync(base, taskFile());
  writeFileSync(head, taskFile({ criterion: "then `tool_choice` is `none`" }));
  writeFileSync(output, "");
  const o = capture();
  assert.equal(runKickbackCli(["amended", base, head], { stdout: o.write, env: { GITHUB_OUTPUT: output } }), 0);
  assert.match(o.text(), /^amended/);
  assert.match(readFileSync(output, "utf8"), /amended<<FLOW_EOF\ntrue\nFLOW_EOF/);

  writeFileSync(output, "");
  const n = capture();
  assert.equal(runKickbackCli(["amended", join(dir, "absent.md"), head], { stdout: n.write, env: { GITHUB_OUTPUT: output } }), 0);
  assert.match(n.text(), /^not amended/);
  assert.match(readFileSync(output, "utf8"), /amended<<FLOW_EOF\nfalse\nFLOW_EOF/);
  assert.equal(runKickbackCli(["amended"], { stdout: () => {}, env: {} }), 0, "no files at all is not an amendment, and not a crash");
});

test("flow-0161: `weakens` keeps a replacement only when KICKBACK_CRITERIA_AMENDED is the literal true, and writes the disclosure", () => {
  const dir = withTmp();
  const file = join(dir, "round.diff");
  const disclosure = join(dir, "disclosure.md");
  const output = join(dir, "output.txt");
  writeFileSync(file, REPLACEMENT);

  writeFileSync(output, "");
  const kept = capture();
  assert.equal(runKickbackCli(["weakens", file], { stdout: kept.write, env: {
    KICKBACK_CRITERIA_AMENDED: "true", KICKBACK_DISCLOSURE_FILE: disclosure, KICKBACK_ROUND: "1", KICKBACK_CAP: "2", GITHUB_OUTPUT: output,
  } }), 0);
  assert.match(kept.text(), /removed a test declaration/, "the trips still reach the step summary");
  assert.match(readFileSync(output, "utf8"), /disclose<<FLOW_EOF\ntrue\nFLOW_EOF/);
  const body = readFileSync(disclosure, "utf8");
  assert.ok(body.startsWith(DISCLOSURE_TITLE));
  assert.match(body, /round 1 of 2/);
  assert.match(body, /src\/route\.test\.mjs: removed an assertion \(line 21\)/);

  for (const value of [undefined, "false", "TRUE", "1"]) {
    writeFileSync(output, "");
    const env = { KICKBACK_DISCLOSURE_FILE: join(dir, `never-${value}.md`), GITHUB_OUTPUT: output };
    if (value !== undefined) env.KICKBACK_CRITERIA_AMENDED = value;
    assert.equal(runKickbackCli(["weakens", file], { stdout: () => {}, env }), 1, `amended=${value} discards`);
    assert.match(readFileSync(output, "utf8"), /disclose<<FLOW_EOF\nfalse\nFLOW_EOF/);
    assert.throws(() => readFileSync(env.KICKBACK_DISCLOSURE_FILE), "a discarded round writes no disclosure");
  }

  // Kept without a disclosure path is still kept: the path is the workflow's to supply.
  assert.equal(runKickbackCli(["weakens", file], { stdout: () => {}, env: { KICKBACK_CRITERIA_AMENDED: "true" } }), 0);
});

test("`card` renders from the hand-back file, and from nothing when the file is unreadable", () => {
  const dir = withTmp();
  const file = join(dir, OUTCOME_FILE);
  writeFileSync(file, JSON.stringify({
    outcome: "disputed", finding: "F", tried: "T",
    recommendation: { action: "merge" }, alternative: "A",
  }));
  const env = { KICKBACK_CHECK: "qa", KICKBACK_LINK: "https://x.test/9", KICKBACK_ROUNDS_USED: "1", KICKBACK_CAP: "2", KICKBACK_AMEND: "The round disputed it." };

  const ok = capture();
  assert.equal(runKickbackCli(["card", file], { stdout: ok.write, env }), 0);
  assert.match(ok.text(), /\*\*Finding\*\* \(`qa`\)/);
  assert.match(ok.text(), /The round disputed it\./);
  assert.match(ok.text(), /Auto-fix rounds used: 1\/2/);

  const missing = capture();
  assert.equal(runKickbackCli(["card", join(dir, "absent.json")], { stdout: missing.write, env }), 0);
  assert.ok(missing.text().startsWith(CARD_FALLBACK_TITLE),
    "a round that died before writing its hand-back still gets a card — the human is never left with a bare label");
});

test("flow-0160: `card` reads KICKBACK_ROUND_PUSHED / KICKBACK_ROUND_OUTCOME, and unset keeps today's card", () => {
  const dir = withTmp();
  const file = join(dir, OUTCOME_FILE);
  writeFileSync(file, JSON.stringify(MERGE_HANDBACK));
  const base = { KICKBACK_CHECK: "qa", KICKBACK_LINK: "https://x.test/9", KICKBACK_ROUNDS_USED: "1", KICKBACK_CAP: "2" };
  const render = (env) => { const o = capture(); assert.equal(runKickbackCli(["card", file], { stdout: o.write, env }), 0); return o.text(); };

  const thrownAway = render({ ...base, KICKBACK_AMEND: PUSH_SIDE_AMENDS["check-weakens"], KICKBACK_ROUND_PUSHED: "false", KICKBACK_ROUND_OUTCOME: "fixed" });
  assert.equal(recOf(thrownAway), `kick back with: ${NOT_PUSHED_CHANGE}`);
  assert.equal(recOf(render({ ...base, KICKBACK_ROUND_PUSHED: "true", KICKBACK_ROUND_OUTCOME: "fixed" })), MERGE_LINE);
  assert.equal(recOf(render({ ...base, KICKBACK_AMEND: "The round DISPUTED the finding and changed no code for it.", KICKBACK_ROUND_PUSHED: "false", KICKBACK_ROUND_OUTCOME: "disputed" })), MERGE_LINE);
  assert.equal(recOf(render({ ...base, KICKBACK_AMEND: "the security check failed" })), MERGE_LINE,
    "`escalate` sets neither variable: no round ran, so there is no push to have missed");
});

test("an unknown subcommand exits 2 with a usage line rather than succeeding silently", () => {
  const err = capture();
  assert.equal(runKickbackCli(["sideways"], { stderr: err.write, env: {} }), 2);
  assert.match(err.text(), /usage: flow-kickback\.mjs/);
  assert.equal(runKickbackCli([], { stderr: () => {}, env: {} }), 2);
});

test("the hand-back location is one named constant, so the prompt and the workflow cannot drift apart", () => {
  assert.equal(OUTCOME_DIR, ".flow-kickback");
  assert.equal(OUTCOME_FILE, "outcome.json");
  assert.equal(MESSAGE_SEPARATOR, "\0");
});
