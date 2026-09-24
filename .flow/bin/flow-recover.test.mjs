// Tests for flow-recover — the stranded-task classifier grades its own homework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyStranded, buildResetEdit, minutesSince, readTasks, DEFAULT_THRESHOLD_MINUTES,
  recoveryBranchCandidates, isTaskPrTitle,
} from "./flow-recover.mjs";

const TH = 75;
const inProgress = { status: "in_progress" };

// ── classifyStranded: the four acceptance cases ──

test("in_progress, branch ahead of base, no open PR, older than threshold -> reopen-pr", () => {
  const d = classifyStranded(
    inProgress,
    { branchExists: true, aheadOfBase: true, hasOpenPr: false, ageMinutes: 90 },
    TH,
  );
  assert.equal(d, "reopen-pr");
});

test("in_progress, no branch/commits, older than threshold -> reset-to-ready", () => {
  const d = classifyStranded(
    inProgress,
    { branchExists: false, aheadOfBase: false, hasOpenPr: false, ageMinutes: 90 },
    TH,
  );
  assert.equal(d, "reset-to-ready");
});

test("in_progress with an open PR -> ok (never disturbed), even when old", () => {
  const d = classifyStranded(
    inProgress,
    { branchExists: true, aheadOfBase: true, hasOpenPr: true, ageMinutes: 9999 },
    TH,
  );
  assert.equal(d, "ok");
});

test("in_progress younger than threshold -> ok (no premature rescue)", () => {
  const d = classifyStranded(
    inProgress,
    { branchExists: true, aheadOfBase: true, hasOpenPr: false, ageMinutes: 10 },
    TH,
  );
  assert.equal(d, "ok");
});

// ── classifyStranded: edges ──

test("only in_progress tasks are ever swept", () => {
  for (const status of ["ready", "in_review", "done", "blocked"]) {
    const d = classifyStranded(
      { status },
      { branchExists: false, aheadOfBase: false, hasOpenPr: false, ageMinutes: 99999 },
      TH,
    );
    assert.equal(d, "ok", `${status} must never be swept`);
  }
});

test("a branch that exists but is not ahead of base resets (no commits to recover)", () => {
  const d = classifyStranded(
    inProgress,
    { branchExists: true, aheadOfBase: false, hasOpenPr: false, ageMinutes: 90 },
    TH,
  );
  assert.equal(d, "reset-to-ready");
});

test("default threshold applies when none is passed", () => {
  assert.equal(DEFAULT_THRESHOLD_MINUTES > 0, true);
  const young = classifyStranded(inProgress, { ageMinutes: DEFAULT_THRESHOLD_MINUTES - 1 });
  assert.equal(young, "ok");
  const old = classifyStranded(inProgress, { ageMinutes: DEFAULT_THRESHOLD_MINUTES + 1 });
  assert.equal(old, "reset-to-ready");
});

// ── buildResetEdit ──

test("buildResetEdit clears the claim and returns to ready", () => {
  assert.deepEqual(buildResetEdit("CAN-51"), {
    id: "CAN-51", status: "ready", owner: "", branch: "", pr: "",
  });
});

// ── minutesSince ──

test("minutesSince computes whole minutes, clamps negatives, nulls on bad input", () => {
  const now = Date.parse("2026-06-18T12:00:00Z");
  assert.equal(minutesSince("2026-06-18T10:30:00Z", now), 90);
  assert.equal(minutesSince("2026-06-18T13:00:00Z", now), 0); // future clamps to 0
  assert.equal(minutesSince("", now), null);
  assert.equal(minutesSince("not-a-date", now), null);
  assert.equal(minutesSince(undefined, now), null);
});

// The regression that made the sweep hostile to live claims: a date-only `started` parsed as
// that day's MIDNIGHT, so a task claimed at 09:23Z was "563 minutes old" the instant it was
// claimed and the next sweep reset it out from under a running worker.
test("a date-only started anchors to end-of-day, not midnight", () => {
  const claimedAt = "2026-08-14";

  // Same-day, well past the 75m threshold measured from midnight — must NOT be sweepable.
  const justAfterClaim = Date.parse("2026-08-14T09:24:00Z");
  assert.equal(minutesSince(claimedAt, justAfterClaim), 0);
  assert.equal(
    classifyStranded(inProgress, { ageMinutes: minutesSince(claimedAt, justAfterClaim) }, TH),
    "ok",
    "a task claimed this morning must never be swept the same morning",
  );

  // Late the same evening is still inside the day — still not sweepable.
  assert.equal(minutesSince(claimedAt, Date.parse("2026-08-14T23:00:00Z")), 0);

  // Past end-of-day the clock finally starts, and the threshold is crossed on the far side.
  assert.equal(minutesSince(claimedAt, Date.parse("2026-08-15T01:00:00Z")), 60);
  assert.equal(
    classifyStranded(
      inProgress,
      { ageMinutes: minutesSince(claimedAt, Date.parse("2026-08-15T01:00:00Z")) },
      TH,
    ),
    "ok",
  );
  assert.equal(minutesSince(claimedAt, Date.parse("2026-08-15T02:00:00Z")), 120);
  assert.equal(
    classifyStranded(
      inProgress,
      { ageMinutes: minutesSince(claimedAt, Date.parse("2026-08-15T02:00:00Z")) },
      TH,
    ),
    "reset-to-ready",
    "a genuinely abandoned date-only claim still self-heals — just a day later",
  );
});

test("a full ISO started ages from the exact claim instant", () => {
  // The precise path new claims take: no end-of-day rounding, no early sweep, and recovery
  // lands exactly one threshold after the claim rather than a day later.
  const claimedAt = "2026-08-14T09:23:00Z";
  assert.equal(minutesSince(claimedAt, Date.parse("2026-08-14T09:24:00Z")), 1);
  assert.equal(
    classifyStranded(inProgress, { ageMinutes: minutesSince(claimedAt, Date.parse("2026-08-14T09:24:00Z")) }, TH),
    "ok",
  );
  assert.equal(minutesSince(claimedAt, Date.parse("2026-08-14T10:43:00Z")), 80);
  assert.equal(
    classifyStranded(inProgress, { ageMinutes: minutesSince(claimedAt, Date.parse("2026-08-14T10:43:00Z")) }, TH),
    "reset-to-ready",
  );
});

// ── readTasks: only in_progress surfaces for the sweep ──

test("readTasks parses id/status/started and skips the template", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-recover-"));
  try {
    writeFileSync(
      join(dir, "0051-x.md"),
      '---\nid: "CAN-51"\nstatus: "in_progress"\nstarted: "2026-06-18"\n---\nbody\n',
    );
    writeFileSync(join(dir, "0050-y.md"), '---\nid: "CAN-50"\nstatus: "done"\n---\nbody\n');
    writeFileSync(join(dir, "_TEMPLATE.md"), '---\nid: "TEMPLATE"\nstatus: "ready"\n---\n');
    const tasks = readTasks(dir);
    const ids = tasks.map((t) => t.id);
    assert.deepEqual(ids, ["CAN-50", "CAN-51"]);
    const inProg = tasks.find((t) => t.status === "in_progress");
    assert.equal(inProg.id, "CAN-51");
    assert.equal(inProg.started, "2026-06-18");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── recoveryBranchCandidates: the store's branch first, the convention second ──
//
// The bug these cover: discovery used ONLY the `flow/<id>-…` glob, which is not what workers
// actually produce. Canonical's own store records `branch: "claude/next-tasks-ahnx30"`, and the
// protocol explicitly tells a cloud session to stay on the branch its harness assigned.

test("a declared branch is tried first, with the convention kept as a fallback", () => {
  assert.deepEqual(
    recoveryBranchCandidates("CAN-51", "claude/ecstatic-goodall-120itl"),
    ["claude/ecstatic-goodall-120itl", "flow/CAN-51-*"],
  );
});

test("no declared branch falls back to the convention alone", () => {
  assert.deepEqual(recoveryBranchCandidates("CAN-51"), ["flow/CAN-51-*"]);
  assert.deepEqual(recoveryBranchCandidates("CAN-51", ""), ["flow/CAN-51-*"]);
  assert.deepEqual(recoveryBranchCandidates("CAN-51", "   "), ["flow/CAN-51-*"]);
  assert.deepEqual(recoveryBranchCandidates("CAN-51", null), ["flow/CAN-51-*"]);
});

test("a declared branch identical to the convention is not emitted twice", () => {
  assert.deepEqual(recoveryBranchCandidates("CAN-51", "flow/CAN-51-*"), ["flow/CAN-51-*"]);
});

// Each candidate is passed to `git ls-remote --heads origin "$pattern"` in the sweep, so a value
// that is not ref-shaped must never reach it. An empty pattern would match EVERY head and hand
// recovery an unrelated branch; a leading dash would be read as an option.
test("a declared branch that is not ref-shaped is dropped rather than passed to git", () => {
  for (const hostile of ["--upload-pack=touch /tmp/x", "-o", "a b", "refs;rm -rf /", "x$(id)"]) {
    assert.deepEqual(
      recoveryBranchCandidates("CAN-51", hostile),
      ["flow/CAN-51-*"],
      `${hostile} must not reach git ls-remote`,
    );
  }
});

// ── isTaskPrTitle: the branch-independent second source ──

test("isTaskPrTitle matches only a LEADING [id], per the Flow PR convention", () => {
  assert.equal(isTaskPrTitle("[CAN-51] Recover stranded tasks", "CAN-51"), true);
  assert.equal(isTaskPrTitle("  [CAN-51] leading space is fine", "CAN-51"), true);
  assert.equal(isTaskPrTitle("[CAN-52] a different task", "CAN-51"), false);
  assert.equal(isTaskPrTitle("chore: touches CAN-51 mid-sentence", "CAN-51"), false);
  assert.equal(isTaskPrTitle("", "CAN-51"), false);
  assert.equal(isTaskPrTitle(undefined, "CAN-51"), false);
  assert.equal(isTaskPrTitle("[CAN-51] x", ""), false);
});

// ── the regression this whole change exists to stop ──
//
// A task on a `claude/…` branch with a live open PR. Discovery by convention alone found no
// branch, so the shell reported hasOpenPr=false, and the classifier — correctly, on those
// facts — said reset-to-ready. The claim was cleared out from under a PR that was open.

test("a live PR found by title keeps the claim, even when the branch glob misses", () => {
  const facts = { branchExists: false, aheadOfBase: false, ageMinutes: 9999 };
  assert.equal(
    classifyStranded(inProgress, { ...facts, hasOpenPr: false }, TH),
    "reset-to-ready",
    "the old behaviour, on the old (wrong) facts",
  );
  assert.equal(
    classifyStranded(inProgress, { ...facts, hasOpenPr: true }, TH),
    "ok",
    "the title match supplies hasOpenPr, and a task with an open PR is never disturbed",
  );
});

// ── readTasks surfaces `branch`, which is what the sweep now reads ──

test("readTasks exposes the branch field so the sweep can prefer it", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-recover-branch-"));
  try {
    writeFileSync(
      join(dir, "0051-x.md"),
      '---\nid: "CAN-51"\nstatus: "in_progress"\nstarted: "2026-06-18T09:00:00Z"\n' +
        'branch: "claude/next-tasks-ahnx30"\n---\nbody\n',
    );
    writeFileSync(
      join(dir, "0052-y.md"),
      '---\nid: "CAN-52"\nstatus: "in_progress"\nstarted: "2026-06-18T09:00:00Z"\n---\nbody\n',
    );
    const tasks = readTasks(dir);
    assert.equal(tasks.find((t) => t.id === "CAN-51").branch, "claude/next-tasks-ahnx30");
    assert.equal(tasks.find((t) => t.id === "CAN-52").branch, "", "absent branch reads as empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── prStateKnown: a destructive sweep must never act on an unknown ──
//
// `gh pr list` failing used to fall back to `[]`, which is indistinguishable from "this task has
// no PR". On a task whose branch also could not be found that gives hasOpenPr=false, and past the
// threshold that is exactly what produces reset-to-ready — so a GitHub 5xx, a rate limit or an
// expired token was enough to clear a live claim. The two facts are now separate.

test("an unknown PR state is never swept, however old the claim", () => {
  const stranded = { branchExists: false, aheadOfBase: false, hasOpenPr: false, ageMinutes: 99999 };
  assert.equal(
    classifyStranded(inProgress, { ...stranded, prStateKnown: true }, TH),
    "reset-to-ready",
    "a KNOWN absence of a PR is still evidence, and still recovers",
  );
  assert.equal(
    classifyStranded(inProgress, { ...stranded, prStateKnown: false }, TH),
    "ok",
    "an UNKNOWN PR state must leave the claim alone — the next sweep asks again",
  );
});

test("prStateKnown also holds back the non-destructive reopen-pr path", () => {
  // Less dangerous than a reset, but a PR opened against a branch whose real PR state we could
  // not read risks a duplicate. Waiting one sweep costs nothing.
  const pushed = { branchExists: true, aheadOfBase: true, hasOpenPr: false, ageMinutes: 90 };
  assert.equal(classifyStranded(inProgress, { ...pushed, prStateKnown: true }, TH), "reopen-pr");
  assert.equal(classifyStranded(inProgress, { ...pushed, prStateKnown: false }, TH), "ok");
});

test("prStateKnown defaults to true, so an un-updated caller is unaffected", () => {
  assert.equal(
    classifyStranded(inProgress, { branchExists: false, aheadOfBase: false, ageMinutes: 9999 }, TH),
    "reset-to-ready",
  );
});
