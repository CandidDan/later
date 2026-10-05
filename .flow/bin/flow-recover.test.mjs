// Tests for flow-recover — the stranded-task classifier grades its own homework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  classifyStranded, buildResetEdit, minutesSince, readTasks, DEFAULT_THRESHOLD_MINUTES,
  recoveryBranchCandidates, isTaskPrTitle, readyOpenPr, buildPromoteEdit,
} from "./flow-recover.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const SELF = join(BIN, "flow-recover.mjs");

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

// ── flow-0104 (#91): the open, non-draft PR whose task never left in_progress ─────────────
//
// The hole these cover is in the EVENT STREAM, not in this helper. Since flow-0039 a worker's PR
// is a draft, and flow-status moves the task to `in_review` on `ready_for_review` — an event that
// cannot fire twice. Hand a task back to `ready` while its PR is already out of draft, let it be
// re-claimed, and nothing can ever move it on again: `in_progress` for ever, with a PR sitting in
// review. flow-done still resolves it on merge, so nothing is lost — but the store is wrong about
// what is in flight, which is the whole of G7. The sweep already asks `gh pr list` about every
// in_progress task, so it is the one place that can see the state and correct it.

const readyPr = {
  hasOpenPr: true, openPrReady: true, prStateKnown: true,
  branchExists: true, aheadOfBase: true, ageMinutes: 90,
};

// Criterion 1.
test("criterion 1: in_progress + an open PR that is not a draft, past the threshold -> promote-in-review", () => {
  assert.equal(classifyStranded(inProgress, readyPr, TH), "promote-in-review");
});

// Criterion 2.
test("criterion 2: the same facts with a DRAFT open PR -> ok", () => {
  assert.equal(
    classifyStranded(inProgress, { ...readyPr, openPrReady: false }, TH),
    "ok",
    "a draft PR is a worker still working — exactly today's behaviour, and the common case",
  );
});

// Criterion 3.
test("criterion 3: the same facts below the threshold -> ok", () => {
  assert.equal(
    classifyStranded(inProgress, { ...readyPr, ageMinutes: TH - 1 }, TH),
    "ok",
    "a worker pushing to a non-draft PR (gh pr create, no --draft) must not be flipped mid-work",
  );
  assert.equal(
    classifyStranded(inProgress, { ...readyPr, ageMinutes: TH }, TH),
    "promote-in-review",
    "'at or past' — the boundary is inclusive, like every other outcome",
  );
});

// Criterion 4.
test("criterion 4: the same facts with an unknown PR state -> ok", () => {
  assert.equal(
    classifyStranded(inProgress, { ...readyPr, prStateKnown: false }, TH),
    "ok",
    "if we could not ASK about PRs, we did not learn that one is out of draft",
  );
});

// Criterion 5.
test("criterion 5: a task that is not in_progress is ok whatever the PR facts", () => {
  for (const status of ["ready", "in_review", "done", "blocked"]) {
    assert.equal(classifyStranded({ status }, readyPr, TH), "ok", `${status} must not be touched`);
    assert.equal(
      classifyStranded({ status }, { ...readyPr, ageMinutes: 99999 }, TH), "ok",
      `${status} must not be touched however old`,
    );
  }
  assert.equal(classifyStranded(null, readyPr, TH), "ok", "no task at all is also ok");
});

// A promote needs an open PR to promote TO. Inconsistent facts (ready but not open) must not
// synthesise one — openPrReady is only ever consulted inside the hasOpenPr branch.
test("openPrReady without an open PR cannot promote", () => {
  assert.equal(
    classifyStranded(inProgress, { ...readyPr, hasOpenPr: false }, TH),
    "reopen-pr",
    "no open PR, pushed work: the pre-existing outcome, unaffected by the new flag",
  );
});

test("openPrReady defaults to false, so every pre-flow-0104 call is unchanged", () => {
  assert.equal(
    classifyStranded(inProgress, { hasOpenPr: true, ageMinutes: 9999 }, TH),
    "ok",
    "an open PR with no draft state supplied is still never disturbed",
  );
});

// ── readyOpenPr: one `gh pr list` call, two questions ────────────────────────────────────

test("readyOpenPr returns the task's open non-draft PR, by the leading-[id] rule", () => {
  const prs = [
    { number: 4, title: "[CAN-52] someone else", isDraft: false, url: "https://x/4" },
    { number: 5, title: "[CAN-51] mine", isDraft: false, isCrossRepository: false, url: "https://github.com/o/r/pull/5" },
  ];
  assert.deepEqual(readyOpenPr(prs, "CAN-51"), { number: 5, url: "https://github.com/o/r/pull/5" });
});

// The sweep's second, title-independent source: a PR whose head IS this task's branch belongs to
// this task whatever it is titled — the case a platform-assigned `claude/…` branch produces.
test("readyOpenPr also matches on the task's branch, so an unconventional title still promotes", () => {
  const prs = [
    { number: 6, title: "wip: no id here", headRefName: "claude/foo-x", isDraft: false, isCrossRepository: false, url: "https://x/6" },
  ];
  assert.deepEqual(readyOpenPr(prs, "CAN-51", "claude/foo-x"), { number: 6, url: "https://x/6" });
  assert.equal(readyOpenPr(prs, "CAN-51", "claude/other"), null, "another branch is not this one");
  assert.equal(readyOpenPr(prs, "CAN-51", ""), null, "no branch known: the head source is silent");
  assert.equal(readyOpenPr(prs, "CAN-51"), null);
  assert.equal(
    readyOpenPr([{ number: 6, title: "wip", headRefName: "claude/foo-x", isDraft: true, url: "https://x/6" }],
      "CAN-51", "claude/foo-x"),
    null,
    "and a draft on the task's own branch is still a worker working",
  );
});

test("readyOpenPr returns null for a draft, a mid-title id, or an unknown draft state", () => {
  const url = "https://github.com/o/r/pull/5";
  assert.equal(readyOpenPr([{ number: 5, title: "[CAN-51] x", isDraft: true, url }], "CAN-51"), null);
  assert.equal(readyOpenPr([{ number: 5, title: "touches CAN-51", isDraft: false, url }], "CAN-51"), null);
  assert.equal(
    readyOpenPr([{ number: 5, title: "[CAN-51] x", url }], "CAN-51"), null,
    "an ABSENT isDraft is an unknown, and an unknown never promotes",
  );
  assert.equal(readyOpenPr([{ number: 5, title: "[CAN-51] x", isDraft: "false", url }], "CAN-51"), null);
});

test("readyOpenPr refuses a PR it could not name safely, and bad input", () => {
  assert.equal(readyOpenPr([{ number: 0, title: "[CAN-51] x", isDraft: false, url: "https://x/0" }], "CAN-51"), null);
  assert.equal(readyOpenPr([{ number: 5, title: "[CAN-51] x", isDraft: false, url: "" }], "CAN-51"), null);
  assert.equal(
    readyOpenPr([{ number: 5, title: "[CAN-51] x", isDraft: false, url: 'https://x/5"z' }], "CAN-51"),
    null,
    "the url is written into a task file; a quote in it would fail apply-board-edits",
  );
  assert.equal(readyOpenPr([], "CAN-51"), null);
  assert.equal(readyOpenPr(null, "CAN-51"), null);
  assert.equal(readyOpenPr([null, "nope"], "CAN-51"), null);
  assert.equal(readyOpenPr([{ number: 5, title: "[CAN-51] x", isDraft: false, url: "https://x/5" }]), null);
});

// Security review on #156: matching is by title or branch name, so on a public repo a fork PR
// titled `[<id>] …` must never promote. Only a same-repo PR may.
test("readyOpenPr never promotes a fork PR, or one whose origin is unknown", () => {
  const url = "https://github.com/o/r/pull/7";
  const fork = { number: 7, title: "[CAN-51] totally legit", isDraft: false, isCrossRepository: true, url };
  assert.equal(readyOpenPr([fork], "CAN-51"), null, "a fork PR spoofing the task id is ignored");
  assert.equal(
    readyOpenPr([{ ...fork, headRefName: "claude/foo-x" }], "CAN-51", "claude/foo-x"), null,
    "and a fork whose branch happens to share the task branch's name is ignored too",
  );
  const { isCrossRepository: _omit, ...unknown } = fork;
  assert.equal(readyOpenPr([unknown], "CAN-51"), null, "absent isCrossRepository is an unknown");
  assert.equal(readyOpenPr([{ ...fork, isCrossRepository: "false" }], "CAN-51"), null);
  // The real one, from this repo, still wins even when a spoof sits beside it.
  assert.deepEqual(
    readyOpenPr([fork, { ...fork, number: 8, isCrossRepository: false, url: "https://github.com/o/r/pull/8" }], "CAN-51"),
    { number: 8, url: "https://github.com/o/r/pull/8" },
  );
});

// ── buildPromoteEdit: the in_review board edit ───────────────────────────────────────────

test("buildPromoteEdit records in_review with the PR url and branch", () => {
  assert.deepEqual(buildPromoteEdit("CAN-51", "https://github.com/o/r/pull/5", "claude/foo-x"), {
    id: "CAN-51", status: "in_review", pr: "https://github.com/o/r/pull/5", branch: "claude/foo-x",
  });
});

test("buildPromoteEdit OMITS a blank or malformed pr/branch rather than writing it", () => {
  // apply-board-edits patches exactly the fields present. "" would clobber a branch the store
  // already knows — and the title match finds a PR precisely when the branch glob missed.
  assert.deepEqual(buildPromoteEdit("CAN-51", "https://x/5", ""), {
    id: "CAN-51", status: "in_review", pr: "https://x/5",
  });
  assert.deepEqual(buildPromoteEdit("CAN-51"), { id: "CAN-51", status: "in_review" });
  for (const hostile of ['https://x/5"', "not-a-url", "javascript:x"]) {
    assert.deepEqual(
      buildPromoteEdit("CAN-51", hostile, "a b"), { id: "CAN-51", status: "in_review" },
      `${hostile} must not reach a task file`,
    );
  }
});

// ── the CLI ──────────────────────────────────────────────────────────────────────────────

const cli = (args, stdin) =>
  execFileSync(process.execPath, [SELF, ...args], { input: stdin ?? "", encoding: "utf8" }).trim();

// Criterion 6. The flag is additive: every answer the CLI gave before flow-0104 it still gives,
// for the identical flags. These expectations are the pre-change behaviour, written out.
test("criterion 6: `classify` without --open-pr-ready answers exactly as it did before", () => {
  const cases = [
    [["--status", "in_progress", "--branch-exists", "1", "--ahead", "1", "--has-open-pr", "0", "--age", "90", "--threshold", "75"], "reopen-pr"],
    [["--status", "in_progress", "--branch-exists", "0", "--ahead", "0", "--has-open-pr", "0", "--age", "90", "--threshold", "75"], "reset-to-ready"],
    [["--status", "in_progress", "--branch-exists", "1", "--ahead", "1", "--has-open-pr", "1", "--age", "9999", "--threshold", "75"], "ok"],
    [["--status", "in_progress", "--branch-exists", "1", "--ahead", "1", "--has-open-pr", "0", "--age", "10", "--threshold", "75"], "ok"],
    [["--status", "in_review", "--has-open-pr", "1", "--age", "9999"], "ok"],
    [["--status", "in_progress", "--has-open-pr", "0", "--age", "9999", "--pr-state-known", "0"], "ok"],
  ];
  for (const [args, want] of cases) {
    assert.equal(cli(["classify", ...args]), want, args.join(" "));
    assert.equal(
      cli(["classify", ...args, "--open-pr-ready", "0"]), want,
      "and passing the flag as 0 is the same as omitting it",
    );
  }
});

test("`classify --open-pr-ready 1` reaches the new outcome through the CLI", () => {
  assert.equal(
    cli(["classify", "--status", "in_progress", "--has-open-pr", "1", "--open-pr-ready", "1",
      "--age", "90", "--threshold", "75"]),
    "promote-in-review",
  );
});

test("`ready-pr` prints <number>\\t<url>, and prints NOTHING when there is no ready PR", () => {
  const prs = JSON.stringify([
    { number: 9, title: "[CAN-51] mine", isDraft: false, isCrossRepository: false, url: "https://github.com/o/r/pull/9" },
  ]);
  assert.equal(cli(["ready-pr", "CAN-51"], prs), "9\thttps://github.com/o/r/pull/9");
  assert.equal(cli(["ready-pr", "CAN-52"], prs), "", "another task's PR is not this task's");
  const byHead = JSON.stringify([
    { number: 9, title: "wip", headRefName: "claude/foo-x", isDraft: false, isCrossRepository: false, url: "https://x/9" },
  ]);
  assert.equal(cli(["ready-pr", "CAN-51", "claude/foo-x"], byHead), "9\thttps://x/9",
    "the branch argument is the second, title-independent source");
  assert.equal(cli(["ready-pr", "CAN-51", ""], byHead), "", "an empty branch matches nothing");
  assert.equal(cli(["ready-pr", "CAN-51"], "not json"), "", "unparseable input never promotes");
  assert.equal(cli(["ready-pr", "CAN-51"], "[]"), "");
  // The same JSON count-task-prs reads: one call, two questions, no extra API request.
  assert.equal(cli(["count-task-prs", "CAN-51"], prs), "1");
});

test("`promote` prints the board-edits JSON apply-board-edits.mjs consumes", () => {
  const out = JSON.parse(cli(["promote", "CAN-51", "https://github.com/o/r/pull/9", "claude/foo-x"]));
  assert.deepEqual(out, {
    updates: [{
      id: "CAN-51", status: "in_review",
      pr: "https://github.com/o/r/pull/9", branch: "claude/foo-x",
    }],
  });
  assert.equal(cli(["promote"]), "", "no id, no edit — the sweep must not write a blank update");
});

// ── criterion 7: the sweep is wired to the new outcome ───────────────────────────────────
//
// Canonical-only: `_flow-recover.yml` is the REUSABLE workflow authored here. An adopting repo
// has a thin caller instead, so asserting on it there would fail a correct repo.
const CANON = (() => {
  const root = resolve(BIN, "..", "..", "..");
  return existsSync(join(root, ".github", "workflows", "_flow-recover.yml")) &&
    existsSync(join(root, "project-template", ".flow", "bin", "flow-recover.mjs")) ? root : null;
})();
const notCanonical = "canonical-only: the reusable _flow-recover.yml is authored in canonical; " +
  "an adopting repo has a thin caller, so there is nothing here to assert on.";

// DEPENDENCY NOTE — see check-workflows.test.mjs. The tooling gate job runs the tests with no
// install step; `yaml` reads the workflow the way GitHub does, so skip visibly without it.
const yamlMod = await import("yaml").then((m) => m, () => null);

test("criterion 7: the sweep passes --open-pr-ready from the PR data it already requests", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  if (!yamlMod) return t.skip("needs `npm ci` (yaml) — runs in the per-stack gate job");
  const wf = yamlMod.parse(
    readFileSync(join(CANON, ".github", "workflows", "_flow-recover.yml"), "utf8"));
  const run = wf.jobs.sweep.steps.map((s) => s.run).filter(Boolean).join("\n");

  // The facts come off a `gh pr list` call the sweep ALREADY makes — the open-PR list it reads
  // for has_open_pr, which gained three fields. A third call per task is the cost this avoids.
  const listCall = run.match(/gh pr list --state open --limit \d+ --json [^\s]+/);
  assert.ok(listCall, "the open-PR list call must still be there");
  for (const field of ["number", "headRefName", "isDraft", "url"]) {
    assert.match(listCall[0], new RegExp(`\\b${field}\\b`),
      `${field} must come off that same call — without it the PR cannot be identified or recorded`);
  }
  assert.equal(
    (run.match(/\$\(gh pr list/g) || []).length, 2,
    "still exactly two gh pr list invocations per task (the list and the --head count)",
  );

  // And the facts reach the classifier, matched by BOTH of the sweep's existing sources.
  assert.match(run, /flow-recover\.mjs ready-pr "\$id" "\$branch"/,
    "id AND branch: the title rule and the head rule stay in the helper, not re-expressed in jq");
  assert.match(run, /flow-recover\.mjs classify[\s\S]{0,400}?--open-pr-ready "\$\{open_pr_ready:-0\}"/,
    "classify must be told, defaulting to 0 — an unreadable draft state never promotes");
});

test("criterion 7: the promote-in-review branch writes in_review + pr + branch and commits to main", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  if (!yamlMod) return t.skip("needs `npm ci` (yaml) — runs in the per-stack gate job");
  const wf = yamlMod.parse(
    readFileSync(join(CANON, ".github", "workflows", "_flow-recover.yml"), "utf8"));
  const run = wf.jobs.sweep.steps.map((s) => s.run).filter(Boolean).join("\n");

  const branch = run.match(/\n\s*promote-in-review\)\n([\s\S]*?)\n\s*;;/);
  assert.ok(branch, "the `case $decision` must have a promote-in-review arm");
  const body = branch[1];

  // status + pr + branch, through the sanctioned writer — the `promote` subcommand is what
  // produces `status: in_review` with those two fields (asserted above against its JSON).
  assert.match(body, /flow-recover\.mjs promote "\$id" "\$open_pr_url" "\$branch"/);
  assert.match(body, /apply-board-edits\.mjs/, "never a hand-edit of the task file");
  assert.match(body, /git commit -m "flow: recover \$id -> in_review \(PR #\$open_pr_number open and ready, status was stuck in_progress\)"/);
  assert.match(body, /git pull --rebase origin main[\s\S]*git push origin main/,
    "committed to main, rebasing first like reset-to-ready — a second promote in one sweep");
  const code = body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/gh pr /.test(code),
    "the sweep corrects the STORE; it must never touch the PR itself (no gh pr ready/edit/comment)");
});

// Criterion 8.
test("criterion 8: the changelog fragment exists and says no caller action is needed", async (t) => {
  if (!CANON) return t.skip(notCanonical);
  // Read through changelog-entry.mjs, never changes/<id>.md: a release folds the fragment into
  // CHANGELOG.md and deletes it, so a direct read is green until the release PR and red on it.
  // Imported here, not at the top: this file ships to adopting repos, which have no such helper.
  const { changelogEntry } = await import(pathToFileURL(join(CANON, ".flow", "bin", "changelog-entry.mjs")).href);
  const text = changelogEntry(CANON, "flow-0104");
  assert.ok(text, "flow-0104's changelog entry must exist, as a fragment or in CHANGELOG.md");
  assert.match(text, /no caller action/i, "an adopting repo has to be told it need do nothing");
});
