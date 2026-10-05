#!/usr/bin/env node
// queue-runner-schedule.mjs — decide whether THIS scheduled tick is the day's queue-runner run.
//
// The queue runner used to be timed by its caller's cron alone: `0 7 * * 1-5` UTC, one tick, one
// run. Two things that cron cannot express turned out to matter (flow-0080):
//
//   1. **A pause that leaves review running.** `vars.FLOW_AI` gates the runner *and* the three
//      PR review checks, triage and compass together, so pausing autonomous work with
//      `FLOW_AI=false` also switched the gate's reviewers off — observed during the 1.x → 2.0.0
//      migrations, where repos briefly had no review at all. `vars.FLOW_QUEUE_RUNNER=paused`
//      is the narrow switch: scheduled ticks do nothing, `workflow_dispatch` still works, and
//      nothing else in the fleet notices.
//   2. **A schedule in the operator's own time zone.** `on:` is parsed statically and cannot
//      read `vars.*`, so GitHub's native `timezone:` on a `schedule` would be a literal in each
//      caller — a file `flow-sync` overwrites, in every repo, edited by hand on every move. So
//      the caller's cron becomes hourly and the *decision* moves here, where it can read
//      `vars.FLOW_TZ` and `vars.FLOW_RUN_HOUR`. One `gh variable set` per repo, no file edit,
//      and daylight saving is the zone database's problem rather than anyone's.
//
// THE GATE IS "FIRST TICK AT OR AFTER THE HOUR, ONCE PER LOCAL DAY" — never "the hour equals".
// GitHub's scheduler is routinely 15 minutes to 2+ hours late at peak (community discussion
// #191400), so an exact-hour match would silently skip a whole day whenever a tick ran late,
// which is the failure the hourly cron was supposed to remove. Lateness therefore delays the
// day's run; it never cancels it.
//
// This module is the pure decision. The I/O — which hour it is, what `vars.*` hold, which
// earlier runs of today already dispatched a worker — is gathered by a thin shell in
// `_flow-queue-runner.yml`, the same split `queue-runner-verify.mjs` and `flow-recover.mjs` use.
// Being pure is what makes a time-of-day rule testable at all: every case below is a fixed
// instant passed in, not a clock anyone has to wait for.
//
//   node .flow/bin/queue-runner-schedule.mjs --event schedule --now 2026-10-02T20:00:00Z \
//        --tz Australia/Sydney --run-hour 7 --runs-file earlier-runs.json
//
// Writes `proceed` / `code` / `reason` to `$GITHUB_OUTPUT` and one line to
// `$GITHUB_STEP_SUMMARY` when those are set, and always prints the reason on stdout. It exits 0
// for *both* answers: "today's run already happened" is a correct outcome, not a failure, and a
// mostly-skipping hourly workflow whose skips looked like failures would be unreadable.
//
// Zero dependencies (Node >= 18).

import { appendFileSync, readFileSync, realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reached
// through a symlink they differ, the CLI block never runs, and the step reads no decision at
// all — which the workflow treats as "do not dispatch", so the runner would quietly stop
// working. See main-module.test.mjs for the full mechanism.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// With neither variable set the runner must behave exactly as it did before flow-0080: one run
// per UTC weekday at 07:00. These two constants are that old cron, restated as data — the hourly
// cron plus "at or after 07:00 UTC, once per UTC day" picks the same tick the `0 7 * * 1-5`
// cron did, and the once-per-day rule stops the other 23 from doing anything.
export const DEFAULT_TZ = "UTC";
export const DEFAULT_RUN_HOUR = 7;

// Variable values reach the step summary and `$GITHUB_OUTPUT`, so they are quoted for a human
// rather than pasted: one line, printable ASCII only, bounded length. A repo variable is set by
// a trusted operator, but "trusted" is not "well-formed" — a stray newline in an echoed value
// would forge an extra `key=value` line in `$GITHUB_OUTPUT`, which is a real injection even
// when nobody meant one.
export function quoteValue(value, max = 60) {
  const flat = String(value ?? "").replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

// Does this runner's ICU build know the zone? `Intl` is the only IANA database present in a
// dependency-free Node, and it throws RangeError on a name it cannot resolve — which is the
// check. Rejecting here is deliberate: a zone nobody recognises must never fall back to UTC and
// run the day's work at the wrong hour while reporting success.
export function isKnownZone(zone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: String(zone) });
    return true;
  } catch { return false; }
}

// The two repo variables, resolved into the zone and hour the decision uses.
//   both unset  -> the pre-flow-0080 default (07:00 UTC), mode "utc-default"
//   both set    -> the local-time schedule, mode "local"
//   one set     -> a misconfiguration, reported. Running on the half-configured intent would be
//                  the silent fallback this whole module refuses: an operator who set FLOW_TZ
//                  and forgot FLOW_RUN_HOUR gets told so on every tick, in the step summary,
//                  rather than discovering weeks later that the time never moved.
export function resolveSchedule({ tz = "", runHour = "" } = {}) {
  const zone = String(tz ?? "").trim();
  const hour = String(runHour ?? "").trim();

  if (zone === "" && hour === "") {
    return { ok: true, tz: DEFAULT_TZ, runHour: DEFAULT_RUN_HOUR, mode: "utc-default" };
  }
  if (zone === "" || hour === "") {
    const [set, missing] = zone === "" ? ["FLOW_RUN_HOUR", "FLOW_TZ"] : ["FLOW_TZ", "FLOW_RUN_HOUR"];
    return {
      ok: false, bad: missing,
      error: `${set} is set but ${missing} is not. The local-time schedule needs both, and ` +
        `half of it is not a schedule — set the other with \`gh variable set ${missing}\`, or ` +
        `unset both to go back to 07:00 UTC on weekdays.`,
    };
  }
  if (!isKnownZone(zone)) {
    return {
      ok: false, bad: "FLOW_TZ",
      error: `FLOW_TZ is not an IANA zone this runner knows: ${quoteValue(zone)}. Use a name ` +
        `from the zone database (e.g. Australia/Sydney, Europe/London) — an unrecognised zone ` +
        `is never treated as UTC, because that would run the day's work at the wrong hour.`,
    };
  }
  if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour)) {
    return {
      ok: false, bad: "FLOW_RUN_HOUR",
      error: `FLOW_RUN_HOUR must be a whole local hour from 0 to 23: ${quoteValue(hour)} is not. ` +
        `It is an hour of the day, not a time — \`7\`, not \`07:00\`.`,
    };
  }
  return { ok: true, tz: zone, runHour: Number(hour), mode: "local" };
}

// The wall clock in `zone` at `instant`: the local date (ISO `YYYY-MM-DD`), hour, minute and
// weekday. `en-CA` is chosen for its ISO-shaped date parts, and the weekday is derived from
// those parts rather than read as a localised name — a name would be a locale dependency in the
// one assertion that must mean the same thing on every runner.
//
// This is also the whole of the daylight-saving story: `Intl` resolves the offset *for that
// instant*, so "07:00 local" is 07:00 on both sides of a DST boundary without anyone editing a
// cron, and the two instants are simply an hour apart in UTC.
export function localParts(instant, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    // Some ICU builds render midnight as hour "24" under hour12:false; `% 24` normalises it.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    // 0 = Sunday … 6 = Saturday, read off the local calendar date at noon UTC so no offset can
    // push it onto the neighbouring day.
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
  };
}

const asDate = (value) => (value instanceof Date ? value : new Date(String(value)));
const isDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const decide = (proceed, code, reason) => ({ proceed, code, reason: reason.replace(/\s+/g, " ").trim() });

// The decision. Inputs are the tick (`now`), the two variables (`tz`, `runHour`), the pause
// switch (`paused`), the event that fired, and `earlierRuns` — this workflow's earlier runs,
// each `{ at, dispatched }`, as observed from the Actions API.
//
// Order matters and is cheapest-first: the three answers that need no run history (paused,
// misconfigured, weekend, not yet this hour) are given before the history is consulted at all,
// so a workflow that is skipping 23 ticks a day pays almost nothing for 23 of them.
export function scheduleDecision({
  event = "schedule",
  paused = false,
  tz = "",
  runHour = "",
  now = new Date(),
  earlierRuns = [],
} = {}) {
  const at = asDate(now);
  if (!isDate(at)) {
    return decide(false, "bad-now",
      `skipped: the tick time handed to the schedule gate is not a datetime (${quoteValue(now)}). ` +
      `This is a wiring fault in _flow-queue-runner.yml, not a configuration one.`);
  }

  // A manual run is a human asking for this task now. It is never second-guessed: not by the
  // hour, not by the weekday, not by the pause switch — pausing the schedule is what pausing
  // the schedule means, and dispatch stays the one way to work a single task on purpose.
  if (event !== "schedule") {
    return decide(true, "manual",
      `run: ${quoteValue(event)} is not a scheduled tick, so the schedule gate does not apply — ` +
      `FLOW_QUEUE_RUNNER, FLOW_TZ and FLOW_RUN_HOUR are ignored for a manual dispatch.`);
  }

  if (paused) {
    return decide(false, "paused",
      `skipped: FLOW_QUEUE_RUNNER is set to "paused", so scheduled runs dispatch no worker. ` +
      `Review, triage and compass are untouched — unlike FLOW_AI=false, which switches those ` +
      `off too. Resume with \`gh variable delete FLOW_QUEUE_RUNNER\` (or set it to any other ` +
      `value); \`workflow_dispatch\` still works while paused.`);
  }

  const cfg = resolveSchedule({ tz, runHour });
  if (!cfg.ok) return decide(false, "bad-config", `skipped: ${cfg.error}`);

  const local = localParts(at, cfg.tz);
  const clock = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  const where = `${clock} ${cfg.tz} on ${local.date}`;

  if (local.weekday === 0 || local.weekday === 6) {
    return decide(false, "weekend",
      `skipped: it is the weekend where the runner is scheduled — ${where} is a ` +
      `${local.weekday === 6 ? "Saturday" : "Sunday"}. The weekday test is the LOCAL one, so a ` +
      `UTC weekday can still be a local weekend.`);
  }

  if (local.hour < cfg.runHour) {
    return decide(false, "before-run-hour",
      `skipped: not this hour yet — ${where}, and FLOW_RUN_HOUR is ${cfg.runHour}. The first ` +
      `tick at or after ${String(cfg.runHour).padStart(2, "0")}:00 local is the day's run.`);
  }

  // Fail closed. `earlierRuns` is the only thing standing between an hourly cron and a worker
  // dispatched every hour, so "I could not find out" must mean "do not run" — never the
  // optimistic reading that there were none.
  if (!Array.isArray(earlierRuns)) {
    return decide(false, "runs-unknown",
      `skipped: the gate could not read this workflow's earlier runs, so it cannot tell whether ` +
      `today's run already happened. It fails closed: an hourly cron that assumes "no earlier ` +
      `run" dispatches a worker every hour. Check the \`actions: read\` grant on the caller's job.`);
  }

  const already = earlierRuns.filter((r) => {
    if (!r || !r.dispatched) return false;
    const ran = asDate(r.at);
    // An entry we cannot place in a day is counted as today's, for the same fail-closed reason.
    return !isDate(ran) || localParts(ran, cfg.tz).date === local.date;
  });
  if (already.length > 0) {
    const first = asDate(already[0].at);
    const when = isDate(first) ? localParts(first, cfg.tz) : null;
    return decide(false, "already-ran-today",
      `skipped: today's run already happened — a scheduled run dispatched a worker at ` +
      `${when ? `${String(when.hour).padStart(2, "0")}:${String(when.minute).padStart(2, "0")} ${cfg.tz}` : "an unreadable time"} ` +
      `on ${local.date}. "Today" is the local date in ${cfg.tz}, so one run per local day holds ` +
      `even across a UTC date change.`);
  }

  return decide(true, "run",
    `run: first tick at or after ${String(cfg.runHour).padStart(2, "0")}:00 ${cfg.tz} on a ` +
    `weekday with nothing dispatched yet today — it is ${where}. ` +
    `${cfg.mode === "utc-default"
      ? "FLOW_TZ and FLOW_RUN_HOUR are unset, so this is the pre-flow-0080 default of 07:00 UTC."
      : "Set by FLOW_TZ + FLOW_RUN_HOUR."}`);
}

// One line, for `$GITHUB_STEP_SUMMARY`. An hourly workflow is mostly skips, and a skip that
// prints nothing is indistinguishable from a runner that has quietly died — so every tick says
// which of the answers it gave, by name, on its own run page.
export function summaryLine({ proceed, code, reason } = {}) {
  return `- **${proceed ? "dispatching" : "no dispatch"}** (\`${code}\`) — ${reason}`;
}

// ── CLI ──

export function parseFlags(argv = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const next = argv[i + 1];
    flags[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? (i += 1, next) : "1";
  }
  return flags;
}

// `--runs-file` holds `[{ "at": "<iso>", "dispatched": true|false }, …]`, written by the
// workflow's gathering step. A missing or malformed file yields `null`, not `[]`: the decision
// reads `null` as "unknown" and refuses to dispatch (see `runs-unknown` above).
export function readRunsFile(path, read = readFileSync) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function decisionArgsFromFlags(flags = {}, { now = new Date(), read = readFileSync } = {}) {
  return {
    event: flags.event ?? "schedule",
    // The raw repo variable, compared here rather than in YAML: `paused` is the only value that
    // pauses, so an unset variable (empty string) can never be misread as "off".
    paused: String(flags["queue-runner"] ?? "").trim() === "paused",
    tz: flags.tz ?? "",
    runHour: flags["run-hour"] ?? "",
    now: flags.now ? flags.now : now,
    earlierRuns: readRunsFile(flags["runs-file"], read),
  };
}

export function runCli(argv = [], { env = process.env, out = process.stdout, append = appendFileSync } = {}) {
  const decision = scheduleDecision(decisionArgsFromFlags(parseFlags(argv)));
  out.write(`${decision.reason}\n`);
  if (env.GITHUB_OUTPUT) {
    append(env.GITHUB_OUTPUT,
      `proceed=${decision.proceed}\ncode=${decision.code}\nreason=${decision.reason}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) append(env.GITHUB_STEP_SUMMARY, `${summaryLine(decision)}\n`);
  return decision;
}

if (__isMain) {
  runCli(process.argv.slice(2));
}
