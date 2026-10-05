// queue-runner-schedule.test.mjs — proving tests for the queue runner's timing decision (flow-0080).
//
// Every test here is a fixed instant handed to a pure function. That is the point of moving the
// decision out of YAML: "does the day's run happen at 07:00 in the operator's zone, even when
// GitHub's scheduler is two hours late, and exactly once" is otherwise only observable by
// watching a cron for a week, which is how a timing bug survives for a week.
//
// The zone used throughout is Australia/Sydney — the operator's, and a useful one: it is far
// enough from UTC that the local date differs from the UTC date for most of the local morning,
// and its DST boundary falls on a Sunday in April, so both of the awkward cases are real rather
// than contrived.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RUN_HOUR,
  DEFAULT_TZ,
  decisionArgsFromFlags,
  isKnownZone,
  localParts,
  parseFlags,
  quoteValue,
  readRunsFile,
  resolveSchedule,
  runCli,
  scheduleDecision,
  summaryLine,
} from "./queue-runner-schedule.mjs";

const SYD = "Australia/Sydney";
// The local-time config the criteria are written against: 07:00 in the operator's zone.
const local = (extra = {}) => ({ tz: SYD, runHour: "7", ...extra });
const dispatched = (at) => ({ at, dispatched: true });

// ── criterion: 06:00 local on a weekday is "before run hour" ─────────────────────────────

test("a tick at 06:00 local on a weekday skips, because the run hour has not arrived", () => {
  // 2026-10-01T20:00Z is Friday 2 October, 06:00 AEST+DST (UTC+10) in Sydney.
  const d = scheduleDecision(local({ now: "2026-10-01T20:00:00Z" }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "before-run-hour");
  assert.match(d.reason, /not this hour yet/, "the summary has to say which skip this was");
  assert.match(d.reason, /06:00 Australia\/Sydney/, "and name the local clock it read");
});

// ── criterion: 07:00 local on a weekday, nothing dispatched yet, runs ────────────────────

test("the 07:00 local tick on a weekday with no earlier dispatch is the day's run", () => {
  const d = scheduleDecision(local({ now: "2026-10-01T21:00:00Z", earlierRuns: [] }));
  assert.equal(d.proceed, true);
  assert.equal(d.code, "run");
  assert.match(d.reason, /07:00 Australia\/Sydney/);
});

// ── criterion: a LATE tick still runs — the gate is "at or after", never "equals" ────────

test("a tick that GitHub fires late (09:40 local) still runs — lateness delays, never cancels", () => {
  // The whole reason the decision is not `hour == FLOW_RUN_HOUR`: GitHub's scheduler runs 15
  // minutes to 2+ hours late at peak, and an exact match would silently skip the day.
  const d = scheduleDecision(local({ now: "2026-10-01T23:40:00Z" }));
  assert.equal(d.proceed, true, "an exact-hour gate would have skipped this whole day");
  assert.equal(d.code, "run");
});

// ── criterion: once per local day ────────────────────────────────────────────────────────

test("a 10:00 local tick skips when a scheduled run already dispatched at 07:05 local today", () => {
  const d = scheduleDecision(local({
    now: "2026-10-02T00:00:00Z",                       // Friday 2 October, 10:00 local
    earlierRuns: [dispatched("2026-10-01T21:05:00Z")], // the same local day, 07:05 local
  }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "already-ran-today");
  assert.match(d.reason, /07:05 Australia\/Sydney/, "the notice names when the day's run went out");
});

test("a run that dispatched NOTHING does not consume the day — a dry queue is not a run", () => {
  const d = scheduleDecision(local({
    now: "2026-10-02T00:00:00Z",
    earlierRuns: [{ at: "2026-10-01T21:05:00Z", dispatched: false }],
  }));
  assert.equal(d.proceed, true, "the 07:00 tick found an empty queue; 10:00 may still find work");
});

// ── criterion: a local Saturday is a weekend, even on a UTC weekday ──────────────────────

test("a local Saturday skips as the weekend even though it is still Friday in UTC", () => {
  // 2026-10-02T21:00Z is Friday in UTC and Saturday 3 October, 07:00, in Sydney.
  const now = "2026-10-02T21:00:00Z";
  assert.equal(new Date(now).getUTCDay(), 5, "fixture check: UTC says Friday");
  const d = scheduleDecision(local({ now }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "weekend");
  assert.match(d.reason, /Saturday/);
});

test("a local Sunday skips too, and says so by name", () => {
  const d = scheduleDecision(local({ now: "2026-10-03T21:00:00Z" }));
  assert.equal(d.code, "weekend");
  assert.match(d.reason, /Sunday/);
});

// ── criterion: "today" is the LOCAL date, not the UTC date ───────────────────────────────

test('"today" is the local date: a dispatch on the same local day blocks, on the previous one does not', () => {
  // The tick: 2026-10-05T23:30Z — Tuesday 6 October, 10:30 local. Its UTC date is the 5th, so
  // every assertion below separates the two calendars.
  const now = "2026-10-05T23:30:00Z";
  assert.equal(localParts(new Date(now), SYD).date, "2026-10-06");
  assert.equal(now.slice(0, 10), "2026-10-05", "fixture check: the UTC date is the day before");

  const sameLocalDay = scheduleDecision(local({
    now, earlierRuns: [dispatched("2026-10-05T20:00:00Z")],   // 07:00 local on the 6th
  }));
  assert.equal(sameLocalDay.code, "already-ran-today",
    "a UTC-date comparison would have called this yesterday's run and dispatched a second worker");

  const previousLocalDay = scheduleDecision(local({
    now, earlierRuns: [dispatched("2026-10-05T04:00:00Z")],   // 15:00 local on the 5th
  }));
  assert.equal(previousLocalDay.proceed, true,
    "a UTC-date comparison would have called this today's run and skipped the day entirely");
});

// ── criterion: daylight saving keeps the run at the same LOCAL hour ──────────────────────

test("the run hour stays 07:00 local on both sides of a DST boundary", () => {
  // Sydney leaves DST at 03:00 on Sunday 5 April 2026 (UTC+11 -> UTC+10), so 07:00 local is
  // 20:00Z before the boundary and 21:00Z after it. Both must be the day's run, and both must
  // read as hour 7 — nobody edits a cron for this.
  const before = "2026-04-02T20:00:00Z";   // Friday 3 April, 07:00 AEDT
  const after = "2026-04-06T21:00:00Z";    // Monday 6 April, 07:00 AEST

  for (const [when, label] of [[before, "before the boundary"], [after, "after the boundary"]]) {
    const parts = localParts(new Date(when), SYD);
    assert.equal(parts.hour, 7, `${label}: the local clock must read 07:00`);
    const d = scheduleDecision(local({ now: when }));
    assert.equal(d.proceed, true, `${label}: ${d.reason}`);
  }

  // The two instants are genuinely an hour apart in UTC — i.e. the zone database moved, and the
  // test is not accidentally comparing the same offset twice.
  const hoursApart = (new Date(after) - new Date(before)) / 3_600_000;
  assert.equal(hoursApart % 24, 1, "fixture check: the UTC offset differs across the boundary");

  // The tick an hour earlier in UTC is 06:00 local after the change: still skipped.
  assert.equal(scheduleDecision(local({ now: "2026-04-06T20:00:00Z" })).code, "before-run-hour");
});

// ── criterion: with both variables unset, today's behaviour holds exactly ────────────────

test("unset FLOW_TZ/FLOW_RUN_HOUR means the 07:00 UTC weekday tick, once per UTC day", () => {
  assert.equal(DEFAULT_TZ, "UTC");
  assert.equal(DEFAULT_RUN_HOUR, 7, "the default is the `0 7 * * 1-5` cron the runner shipped with");

  // Thursday 1 October 2026: the ticks before 07:00 do nothing.
  for (const when of ["2026-10-01T00:00:00Z", "2026-10-01T06:00:00Z"]) {
    assert.equal(scheduleDecision({ now: when }).code, "before-run-hour", when);
  }
  // The 07:00 UTC tick is the run.
  const run = scheduleDecision({ now: "2026-10-01T07:00:00Z" });
  assert.equal(run.proceed, true);
  assert.match(run.reason, /pre-flow-0080 default of 07:00 UTC/,
    "the reason must say it is running on the default, not on a configured schedule");

  // Every later tick that day sees the dispatch and skips: once per UTC day.
  for (const when of ["2026-10-01T08:00:00Z", "2026-10-01T23:00:00Z"]) {
    const d = scheduleDecision({ now: when, earlierRuns: [dispatched("2026-10-01T07:02:00Z")] });
    assert.equal(d.code, "already-ran-today", when);
  }
  // Yesterday's run does not block today's.
  assert.equal(
    scheduleDecision({ now: "2026-10-02T07:00:00Z", earlierRuns: [dispatched("2026-10-01T07:02:00Z")] }).proceed,
    true, "a new UTC day is a new run");
  // And the weekend is still the weekend.
  assert.equal(scheduleDecision({ now: "2026-10-03T07:00:00Z" }).code, "weekend");
});

// ── criterion: a bad variable is reported, never silently defaulted ──────────────────────

test("an unknown FLOW_TZ skips with a reason naming FLOW_TZ — it is never treated as UTC", () => {
  const d = scheduleDecision({ now: "2026-10-01T07:00:00Z", tz: "Mars/Olympus", runHour: "7" });
  assert.equal(d.proceed, false);
  assert.equal(d.code, "bad-config");
  assert.match(d.reason, /FLOW_TZ/);
  assert.match(d.reason, /Mars\/Olympus/, "the operator needs to see the value they set");
  assert.equal(isKnownZone("Mars/Olympus"), false);
  assert.equal(isKnownZone(SYD), true);
});

test("a FLOW_RUN_HOUR outside 0-23 skips with a reason naming FLOW_RUN_HOUR", () => {
  for (const bad of ["24", "-1", "7.5", "07:00", "seven", "1e1", " "]) {
    const d = scheduleDecision({ now: "2026-10-01T07:00:00Z", tz: SYD, runHour: bad });
    assert.equal(d.code, "bad-config", `FLOW_RUN_HOUR=${bad} must not be accepted`);
    assert.match(d.reason, /FLOW_RUN_HOUR/);
  }
  // The ends of the range are valid, and `0` must not be read as "unset".
  assert.equal(resolveSchedule({ tz: SYD, runHour: "0" }).runHour, 0);
  assert.equal(resolveSchedule({ tz: SYD, runHour: "23" }).runHour, 23);
  assert.equal(scheduleDecision({ now: "2026-10-01T13:00:00Z", tz: SYD, runHour: "0" }).proceed, true,
    "FLOW_RUN_HOUR=0 means midnight local, not 'unconfigured'");
});

test("half a configuration is a reported skip, not a fallback to the other half", () => {
  const onlyZone = scheduleDecision({ now: "2026-10-01T07:00:00Z", tz: SYD });
  assert.equal(onlyZone.code, "bad-config");
  assert.match(onlyZone.reason, /FLOW_RUN_HOUR is not/);

  const onlyHour = scheduleDecision({ now: "2026-10-01T07:00:00Z", runHour: "7" });
  assert.equal(onlyHour.code, "bad-config");
  assert.match(onlyHour.reason, /FLOW_TZ is not/);

  assert.equal(resolveSchedule({}).mode, "utc-default", "both unset is a configuration, not an error");
  assert.equal(resolveSchedule({ tz: SYD, runHour: "7" }).mode, "local");
});

// ── the pause switch, as the decision sees it ────────────────────────────────────────────

test("FLOW_QUEUE_RUNNER=paused stops a scheduled tick and says how to resume", () => {
  const d = scheduleDecision(local({ now: "2026-10-01T21:00:00Z", paused: true }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "paused");
  assert.match(d.reason, /FLOW_QUEUE_RUNNER/, "the summary must name the pause");
  assert.match(d.reason, /gh variable delete FLOW_QUEUE_RUNNER/, "and how to resume");
  assert.match(d.reason, /Review, triage and compass are untouched/,
    "the point of this switch over FLOW_AI=false is what it leaves running");
});

test("only the literal value `paused` pauses — an unset variable can never read as off", () => {
  const args = (value) => decisionArgsFromFlags({ "queue-runner": value });
  assert.equal(args("paused").paused, true);
  assert.equal(args(" paused ").paused, true, "a value pasted with whitespace still pauses");
  for (const value of ["", "false", "true", "PAUSED", "pause", undefined]) {
    assert.equal(args(value).paused, false, `${JSON.stringify(value)} must not pause the runner`);
  }
});

test("a manual dispatch runs even while paused — the schedule gate does not apply to it", () => {
  const d = scheduleDecision(local({
    event: "workflow_dispatch", paused: true,
    now: "2026-10-03T21:00:00Z",                        // a local Saturday, before the run hour
    earlierRuns: [dispatched("2026-10-03T20:00:00Z")],  // and today's run already went out
  }));
  assert.equal(d.proceed, true, "every schedule reason to skip is present; dispatch ignores all of them");
  assert.equal(d.code, "manual");
  assert.match(d.reason, /schedule gate does not apply/);
});

// ── fail-closed behaviour ────────────────────────────────────────────────────────────────

test("unknown run history fails CLOSED — an hourly cron must not assume there were none", () => {
  const d = scheduleDecision(local({ now: "2026-10-01T21:00:00Z", earlierRuns: null }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "runs-unknown");
  assert.match(d.reason, /actions: read/, "the reason has to name the likely cause");
});

test("a dispatched run with an unreadable timestamp is counted as today's", () => {
  const d = scheduleDecision(local({ now: "2026-10-01T21:00:00Z", earlierRuns: [dispatched("not a date")] }));
  assert.equal(d.code, "already-ran-today");
  assert.match(d.reason, /unreadable time/);
});

test("a nonsense tick time is reported as a wiring fault, and does not dispatch", () => {
  const d = scheduleDecision(local({ now: "yesterday-ish" }));
  assert.equal(d.proceed, false);
  assert.equal(d.code, "bad-now");
  assert.match(d.reason, /wiring fault/);
});

test("the pause is checked before the schedule, so a paused repo never needs its run history", () => {
  // Ordering, as a property: paused wins over everything the history or the clock could say.
  const d = scheduleDecision(local({ now: "2026-10-01T21:00:00Z", paused: true, earlierRuns: null }));
  assert.equal(d.code, "paused", "a paused repo must not fail closed on history it never gathered");
});

// ── reasons and the step summary ─────────────────────────────────────────────────────────

test("every reason is a single line, so it is safe in $GITHUB_OUTPUT and reads in a summary", () => {
  const cases = [
    local({ now: "2026-10-01T20:00:00Z" }),
    local({ now: "2026-10-01T21:00:00Z" }),
    local({ now: "2026-10-01T21:00:00Z", paused: true }),
    local({ now: "2026-10-03T21:00:00Z" }),
    { now: "2026-10-01T07:00:00Z", tz: "Mars/Olympus", runHour: "7" },
    local({ now: "2026-10-01T21:00:00Z", earlierRuns: null }),
  ];
  for (const input of cases) {
    const d = scheduleDecision(input);
    assert.doesNotMatch(d.reason, /[\r\n]/, `multi-line reason would forge a $GITHUB_OUTPUT line: ${d.code}`);
    assert.ok(d.reason.length > 0);
    assert.match(summaryLine(d), /^- \*\*(dispatching|no dispatch)\*\* \(`[a-z-]+`\) — /,
      "one markdown line per tick, naming the answer");
  }
});

test("a variable value echoed into a reason is flattened and bounded", () => {
  assert.equal(quoteValue("Australia/Sydney"), '"Australia/Sydney"');
  assert.equal(quoteValue("line\nbreak"), '"line break"');
  assert.doesNotMatch(quoteValue("x".repeat(500)), /[\r\n]/);
  assert.ok(quoteValue("x".repeat(500)).length < 80, "bounded, so a pasted blob cannot flood the summary");
  const d = scheduleDecision({ now: "2026-10-01T07:00:00Z", tz: "Bad\nZone", runHour: "7" });
  assert.doesNotMatch(d.reason, /[\r\n]/);
});

// ── the CLI shell the workflow actually invokes ──────────────────────────────────────────

test("parseFlags reads `--flag value`, `--flag=value` and bare flags", () => {
  assert.deepEqual(parseFlags(["--tz", "UTC", "--run-hour=7", "--paused", "--event", "schedule"]),
    { tz: "UTC", "run-hour": "7", paused: "1", event: "schedule" });
  assert.deepEqual(parseFlags([]), {});
  assert.deepEqual(parseFlags(["stray", "--tz", "UTC"]), { tz: "UTC" });
});

test("readRunsFile returns [] with no file, the parsed array with one, and null when unusable", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-sched-"));
  try {
    const good = join(dir, "runs.json");
    writeFileSync(good, JSON.stringify([dispatched("2026-10-01T07:02:00Z")]));
    assert.deepEqual(readRunsFile(good), [dispatched("2026-10-01T07:02:00Z")]);
    assert.deepEqual(readRunsFile(""), []);
    assert.equal(readRunsFile(join(dir, "missing.json")), null, "a missing file is UNKNOWN, not empty");
    writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readRunsFile(join(dir, "bad.json")), null);
    writeFileSync(join(dir, "obj.json"), '{"at":"x"}');
    assert.equal(readRunsFile(join(dir, "obj.json")), null, "an object is not a list of runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli writes proceed/code/reason to $GITHUB_OUTPUT and one line to the step summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-sched-cli-"));
  try {
    const output = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    const runs = join(dir, "runs.json");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    writeFileSync(runs, "[]");

    const chunks = [];
    const decision = runCli(
      ["--event", "schedule", "--now", "2026-10-01T21:00:00Z", "--tz", SYD, "--run-hour", "7",
       "--queue-runner", "", "--runs-file", runs],
      { env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, out: { write: (s) => chunks.push(s) } },
    );

    assert.equal(decision.proceed, true);
    const written = readFileSync(output, "utf8");
    assert.match(written, /^proceed=true$/m, "the workflow reads this exact key");
    assert.match(written, /^code=run$/m);
    assert.match(written, /^reason=run: first tick at or after 07:00 Australia\/Sydney/m);
    assert.equal(written.trim().split("\n").length, 3, "three keys, one line each");
    assert.match(readFileSync(summary, "utf8"), /^- \*\*dispatching\*\* \(`run`\)/);
    assert.match(chunks.join(""), /^run: /, "the reason is on stdout too, for the raw log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli with no GitHub env still decides, and a paused tick writes `proceed=false`", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-sched-cli2-"));
  try {
    const output = join(dir, "output.txt");
    writeFileSync(output, "");
    const chunks = [];
    const bare = runCli(["--now", "2026-10-01T21:00:00Z", "--tz", SYD, "--run-hour", "7"],
      { env: {}, out: { write: (s) => chunks.push(s) } });
    assert.equal(bare.code, "run");
    assert.match(chunks.join(""), /^run: /);

    runCli(["--now", "2026-10-01T21:00:00Z", "--queue-runner", "paused"],
      { env: { GITHUB_OUTPUT: output }, out: { write: () => {} } });
    assert.match(readFileSync(output, "utf8"), /^proceed=false$/m);
    assert.match(readFileSync(output, "utf8"), /^code=paused$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI block runs as a script and exits 0 for BOTH answers", () => {
  // A skip is a correct outcome, not a failure: an hourly workflow whose 23 skipped ticks showed
  // as red would be unreadable, and nobody would notice the run that mattered.
  const script = join(import.meta.dirname, "queue-runner-schedule.mjs");
  const run = (args) => execFileSync("node", [script, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  assert.match(run(["--now", "2026-10-01T21:00:00Z", "--tz", SYD, "--run-hour", "7"]), /^run: /,
    "silence here is the symlink/main-module failure: the step would read no decision at all");
  assert.match(run(["--now", "2026-10-01T20:00:00Z", "--tz", SYD, "--run-hour", "7"]), /^skipped: not this hour yet/);
  assert.match(run(["--now", "2026-10-01T21:00:00Z", "--queue-runner", "paused"]), /^skipped: FLOW_QUEUE_RUNNER/);
});
