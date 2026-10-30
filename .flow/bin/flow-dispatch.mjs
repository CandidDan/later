#!/usr/bin/env node
// flow-dispatch.mjs — fire the worker routine for the next `ready` task (flow-0182).
//
// A Flow worker runs as a Claude Code cloud routine (docs/flow-routines.md in canonical): one
// routine per model tier per repo, started by POSTing the task id to that routine's API trigger.
// This helper is the thing that POSTs. `_flow-dispatch.yml` runs it on every push to
// `.flow/tasks/**` on `main`, after flow-unblock and flow-recover finish, once a day as the sweep,
// and on demand.
//
// ONE RUN, IN ORDER:
//
//   1. Count the `in_progress` tasks. At or above `dispatch.max_in_progress` (.flow/config.yml,
//      default 3) → skipped, reason=at-capacity.
//   2. Pick with pick-task.mjs (highest priority `ready`, no `touches` overlap with in-flight work).
//      Nothing → skipped, reason=nothing-ready.
//   3. Resolve the task's tier with task-model.mjs (unset is `sonnet`).
//   4. No `FLOW_ROUTINE_<TIER>_ID` or no `FLOW_ROUTINE_<TIER>_TOKEN` → skipped,
//      reason=no-routine-for-<tier>, exit 0. A repo that has not set up routines stays green.
//   5. Re-read the task from `main` as it is NOW (git fetch). Not `ready` any more → skipped,
//      reason=no-longer-ready. The tier is resolved again from that copy, so a task escalated
//      since the checkout fires the routine for its new tier.
//   6. POST {"text": "<task-id>"} to the routine's fire endpoint. 2xx → fired. Anything else →
//      failed, exit 1, naming the status and the tier.
//
// AT MOST ONE TASK PER RUN. The claim the fired worker pushes is a push to `.flow/tasks/`, which
// starts the next run; that chain is how parallel work fans out, and step 1 is what ends it.
//
// EXACTLY ONE DECISION LINE PER RUN, on stdout:
//
//   flow-dispatch: decision=fired task=<id> tier=<tier>
//   flow-dispatch: decision=skipped reason=<reason> [...]
//   flow-dispatch: decision=failed reason=<reason> [...]
//
// THE TOKEN IS NEVER PRINTED. It is read from the environment, used in one request header, and
// scrubbed from the one place a server could echo it back (the error body). The workflow passes it
// only through `secrets:` and a step's `env:`, never interpolated into `run:`.
//
//   node .flow/bin/flow-dispatch.mjs
//
// Pure core, thin CLI. Zero dependencies (Node >= 18, for the global fetch).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync as __realpathSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { yamlScalar } from "./flow-doctor.mjs";
import { parseTask, pickTask, readTasks } from "./pick-task.mjs";
import { findTaskFile, resolve as resolveModel } from "./task-model.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Through a
// symlink they differ and the CLI block silently never runs — dispatch would exit 0 having fired
// nothing. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

export const FIRE_BASE = "https://api.anthropic.com/v1/claude_code/routines";
// From Anthropic's "Trigger a routine through the API" doc; the same value docs/flow-routines.md
// shows in its curl example.
export const ANTHROPIC_VERSION = "2026-10-21";
export const DEFAULT_MAX_IN_PROGRESS = 3;
const FIRE_TIMEOUT_MS = 30_000;

// A trigger id goes into the URL path. Anything outside this shape could walk the path, so it is
// refused rather than encoded.
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The fire endpoint for one routine trigger id. */
export function fireUrl(id) {
  return `${FIRE_BASE}/${id}/fire`;
}

/**
 * `dispatch.max_in_progress` from a `.flow/config.yml` text, with no YAML dependency. Absent block
 * or absent key → the default. A value that is not a positive whole number throws: a typo that
 * quietly fell back would change how many workers run with nothing saying so.
 */
export function readMaxInProgress(configText) {
  const lines = String(configText ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^dispatch:\s*(#.*)?$/.test(l));
  if (start === -1) return DEFAULT_MAX_IN_PROGRESS;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;                       // the next top-level key ends the block
    const m = line.match(/^\s+max_in_progress:(.*)$/);
    if (!m) continue;
    const raw = yamlScalar(m[1]);
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(`dispatch.max_in_progress: "${raw}" is not a positive whole number`);
    }
    return parseInt(raw, 10);
  }
  return DEFAULT_MAX_IN_PROGRESS;
}

/** The env names for a tier's routine: `FLOW_ROUTINE_SONNET_ID` / `FLOW_ROUTINE_SONNET_TOKEN`. */
export function routineEnvNames(tier) {
  const t = String(tier).toUpperCase();
  return { id: `FLOW_ROUTINE_${t}_ID`, token: `FLOW_ROUTINE_${t}_TOKEN` };
}

/** The tier's routine `{ id, token }`, or null when either half is missing or blank. */
export function routineFor(tier, env) {
  const names = routineEnvNames(tier);
  const id = String(env?.[names.id] ?? "").trim();
  const token = String(env?.[names.token] ?? "").trim();
  return id && token ? { id, token } : null;
}

/** Steps 1 and 2: `{ decision: "skipped", reason, ... }` or `{ decision: "pick", taskId }`. */
export function planDispatch(tasks, maxInProgress) {
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  if (inProgress >= maxInProgress) {
    return { decision: "skipped", reason: "at-capacity", in_progress: inProgress, max: maxInProgress };
  }
  const taskId = pickTask(tasks);
  if (!taskId) return { decision: "skipped", reason: "nothing-ready" };
  return { decision: "pick", taskId };
}

/** `flow-dispatch: decision=<d> k=v ...` — the one line a run prints about what it decided. */
export function decisionLine(decision, fields = {}) {
  const rest = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return ["flow-dispatch:", `decision=${decision}`, ...rest].join(" ");
}

// Collapse a response body to one short line with the token taken out.
function safeSnippet(body, token) {
  let s = String(body ?? "").replace(/\s+/g, " ").trim();
  if (token) s = s.split(token).join("***");
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * The text of the task file as it is on `origin/main` right now. Fetches first, so a claim or a
 * reset pushed since the job's checkout is seen. Throws when git cannot answer: firing on a copy
 * that could not be checked is the one thing step 5 exists to prevent.
 */
export function readLatestFromMain(file, { cwd = process.cwd() } = {}) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  git(["fetch", "--quiet", "origin", "main"]);
  const rel = relative(__realpathSync(top), __realpathSync(file)).split("\\").join("/");
  return git(["show", `FETCH_HEAD:${rel}`]);
}

/**
 * One dispatch run. Returns the exit code; prints exactly one decision line through `log`.
 *
 *   tasksDir     the store
 *   configText   `.flow/config.yml`'s text ("" when the file is absent)
 *   env          where the routine ids and tokens are read
 *   fetchImpl    the HTTP client (global fetch in the CLI; a stub in tests)
 *   readLatest   (file, taskId) → the task's text on main now
 */
export async function dispatch({
  tasksDir, configText = "", env = process.env, fetchImpl = globalThis.fetch,
  readLatest = (file) => readLatestFromMain(file), log = console.log, error = console.error,
} = {}) {
  const say = (decision, fields) => {
    const line = decisionLine(decision, fields);
    log(line);
    if (env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(env.GITHUB_STEP_SUMMARY, `\`${line}\`\n`); } catch { /* summary is a nicety */ }
    }
  };
  const fail = (fields, message) => {
    say("failed", fields);
    error(`::error::flow-dispatch: ${message}`);
    return 1;
  };

  let maxInProgress;
  try { maxInProgress = readMaxInProgress(configText); } catch (e) {
    return fail({ reason: "bad-config" }, e.message);
  }

  const plan = planDispatch(readTasks(tasksDir), maxInProgress);
  if (plan.decision === "skipped") {
    const { decision, ...fields } = plan;
    say(decision, fields);
    return 0;
  }
  const taskId = plan.taskId;
  const file = findTaskFile(tasksDir, taskId);
  if (!file) return fail({ reason: "task-not-found", task: taskId }, `no task file holds id ${taskId}`);

  let tier;
  try { tier = resolveModel(readFileSync(file, "utf8")).tier; } catch (e) {
    return fail({ reason: "bad-model", task: taskId }, `${taskId}: ${e.message}`);
  }
  if (!routineFor(tier, env)) {
    say("skipped", { reason: `no-routine-for-${tier}`, task: taskId });
    return 0;
  }

  // Step 5: the task as `main` holds it at the moment of the call.
  let latest;
  try { latest = readLatest(file, taskId); } catch (e) {
    return fail({ reason: "reread-failed", task: taskId, tier },
      `could not re-read ${taskId} from main, so it was not fired: ${String(e?.message ?? e).split("\n")[0]}`);
  }
  const now = parseTask(String(latest ?? ""));
  if (!now || now.status !== "ready") {
    say("skipped", { reason: "no-longer-ready", task: taskId, status: now?.status || "missing" });
    return 0;
  }
  try { tier = resolveModel(String(latest)).tier; } catch (e) {
    return fail({ reason: "bad-model", task: taskId }, `${taskId}: ${e.message}`);
  }
  const routine = routineFor(tier, env);
  if (!routine) {
    say("skipped", { reason: `no-routine-for-${tier}`, task: taskId });
    return 0;
  }
  if (!ROUTINE_ID.test(routine.id)) {
    const { id } = routineEnvNames(tier);
    return fail({ reason: "bad-routine-id", task: taskId, tier },
      `${id} is not a routine trigger id (letters, digits, '-' and '_' only)`);
  }

  // Step 6: fire.
  let res;
  try {
    res = await fetchImpl(fireUrl(routine.id), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${routine.token}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: taskId }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
  } catch (e) {
    return fail({ reason: "network", task: taskId, tier },
      `the fire call for ${taskId} on the ${tier} routine did not complete: ` +
      safeSnippet(e?.message ?? e, routine.token));
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* the status is enough */ }
    return fail({ reason: "http", task: taskId, tier, status: res.status },
      `the ${tier} routine's fire endpoint answered HTTP ${res.status} for ${taskId}` +
      (body ? `: ${safeSnippet(body, routine.token)}` : ""));
  }
  say("fired", { task: taskId, tier });
  return 0;
}

/** The CLI, shared with canonical's adapter so the two shells cannot drift. Returns the exit code. */
export async function runDispatchCli(argv, { flowDir, ...io } = {}) {
  if (argv.length) {
    (io.error ?? console.error)("usage: flow-dispatch.mjs   (no arguments; reads FLOW_ROUTINE_<TIER>_ID/_TOKEN)");
    return 2;
  }
  let configText = "";
  try { configText = readFileSync(join(flowDir, "config.yml"), "utf8"); } catch { /* defaults */ }
  return dispatch({ tasksDir: join(flowDir, "tasks"), configText, ...io });
}

// ── CLI ── In an adopting repo this file is copied to `.flow/bin/`, so the store is that repo's
// `.flow/`. In canonical it would be the template's fixture store — canonical runs its adapter.
if (__isMain) {
  const flowDir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(await runDispatchCli(process.argv.slice(2), { flowDir }));
}
