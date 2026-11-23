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
//      reason=no-routine-for-<tier>, exit 0. A repo that has not set up routines stays green, but
//      it is not silent (flow-0211): one open issue per tier, labelled `flow-dispatch`, says which
//      ready tasks wait on that tier and which two settings are missing (names only, never values).
//      A later run updates that issue rather than opening another, and closes it once it fires the
//      tier's routine. Issue calls that fail leave the run green and say so in the job summary.
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
// THE ISSUE (flow-0211) needs `GITHUB_TOKEN` and `GITHUB_REPOSITORY` in the environment, and
// `issues: write` granted by the CALLER: `_flow-dispatch.yml` declares no permissions of its own
// and inherits the caller's grant, so a repo whose caller has not been synced gets a 403 here and
// a summary line, never a failed run. Without the two variables, no issue call is made at all.
//
// THE TOKEN IS NEVER PRINTED. It is read from the environment, used in one request header, and
// scrubbed from the one place a server could echo it back (the error body). The workflow passes it
// only through `secrets:` and a step's `env:`, never interpolated into `run:`.
//
//   node .flow/bin/flow-dispatch.mjs
//
// STORE OVERRIDE. `FLOW_DISPATCH_FLOW_DIR=<dir>` makes the CLI read `<dir>/tasks/` and
// `<dir>/config.yml` instead of the `.flow/` this file sits in. It exists so a test can run the
// CLI against a fixture store and never read the real tasks of the repo it runs in (flow-0198).
// Unset or empty: the default, this file's own `.flow/`.
//
// Pure core, thin CLI. Zero dependencies (Node >= 18, for the global fetch).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync as __realpathSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { yamlScalar } from "./flow-doctor.mjs";
import { DEFAULT_CANONICAL_REPO } from "./flow-init.mjs";
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

// ── the no-routine issue (flow-0211) ────────────────────────────────────────────────────
// Module-private on purpose: canonical's adapter must re-export every named export
// (adapters.test.mjs), and these are reached only through `dispatch`.

const ISSUE_LABEL = "flow-dispatch";
const ROUTINES_DOC = "docs/flow-routines.md";
const GITHUB_TIMEOUT_MS = 15_000;

/** The hidden line that tells this tier's issue apart from every other issue carrying the label. */
const issueMarker = (tier) => `<!-- flow-dispatch:no-routine:${tier} -->`;

function issueTitle(tier) {
  return `Flow cannot start ${tier} tasks: no routine is configured for the ${tier} tier`;
}

/** The issue body. Built from setting NAMES and task ids only, so it can hold no secret value. */
function issueBody(tier, ids) {
  const names = routineEnvNames(tier);
  const n = ids.length;
  return [
    issueMarker(tier),
    "",
    `${n} ready task${n === 1 ? "" : "s"} ${n === 1 ? "uses" : "use"} the **${tier}** model tier, but this ` +
      `repo has no ${tier} routine set up, so Flow cannot start ${n === 1 ? "it" : "them"}.`,
    "",
    `Waiting: ${ids.map((id) => `\`${id}\``).join(", ")}`,
    "",
    "Missing settings (set both):",
    "",
    `- the repository variable \`${names.id}\``,
    `- the repository secret \`${names.token}\``,
    "",
    `How to set them up: \`${ROUTINES_DOC}\` in ${DEFAULT_CANONICAL_REPO}.`,
    "",
    `Flow updates this issue on each dispatch run and closes it once it starts a ${tier} task.`,
  ].join("\n");
}

/** Ids of every `ready` task whose resolved tier is `tier`, in store order. */
function readyIdsForTier(tasksDir, tier) {
  const ids = [];
  for (const t of readTasks(tasksDir)) {
    if (t.status !== "ready") continue;
    const file = findTaskFile(tasksDir, t.id);
    if (!file) continue;
    try {
      if (resolveModel(readFileSync(file, "utf8")).tier === tier) ids.push(t.id);
    } catch { /* a task with a bad model is reported when it is picked, not here */ }
  }
  return ids;
}

/**
 * A small GitHub issues client over `fetchImpl`, or null when the environment cannot authenticate
 * (no `GITHUB_TOKEN`, or no well-formed `GITHUB_REPOSITORY`). Every non-2xx answer throws, naming
 * the status and never the body.
 */
function githubIssues(env, fetchImpl) {
  const token = String(env?.GITHUB_TOKEN ?? "").trim();
  const repo = String(env?.GITHUB_REPOSITORY ?? "").trim();
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const api = String(env?.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} to ${method} ${path.split("?")[0]}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    listLabelled: () => call("GET", `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`),
    listRecent: () => call("GET", "/issues?state=open&sort=created&direction=desc&per_page=100"),
    create: (title, body) => call("POST", "/issues", { title, body, labels: [ISSUE_LABEL] }),
    update: (number, title, body) => call("PATCH", `/issues/${number}`, { title, body }),
    comment: (number, body) => call("POST", `/issues/${number}/comments`, { body }),
    close: (number) => call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" }),
  };
}

// The body marker, not the label, is what identifies a tier's issue. The label query comes first
// because it is the cheap, exact one; the newest open issues are read as well when it finds
// nothing, because GitHub silently drops labels a token may not set, and an issue that lost its
// label must still be found, or every run would open another one.
async function findTierIssue(github, tier) {
  const pick = (list) => (Array.isArray(list) ? list : [])
    .filter((i) => !i.pull_request && String(i.body ?? "").includes(issueMarker(tier)))
    .sort((a, b) => a.number - b.number)[0] ?? null;
  return pick(await github.listLabelled()) ?? pick(await github.listRecent());
}

/** Make sure exactly one open issue names this tier, carrying the current ids. */
async function ensureNoRoutineIssue(github, tier, ids) {
  const title = issueTitle(tier);
  const body = issueBody(tier, ids);
  const found = await findTierIssue(github, tier);
  if (!found) {
    const made = await github.create(title, body);
    return { action: "opened", number: made?.number, url: made?.html_url };
  }
  if (found.body === body && found.title === title) {
    return { action: "unchanged", number: found.number, url: found.html_url };
  }
  await github.update(found.number, title, body);
  return { action: "updated", number: found.number, url: found.html_url };
}

/** Close this tier's issue, if one is open, with a one-line comment. */
async function closeTierIssue(github, tier, taskId) {
  const found = await findTierIssue(github, tier);
  if (!found) return { action: "none" };
  await github.comment(found.number,
    `Flow started \`${taskId}\` on the ${tier} routine, so the ${tier} tier is set up now. Closing.`);
  await github.close(found.number);
  return { action: "closed", number: found.number, url: found.html_url };
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
  github = githubIssues(env, fetchImpl),
} = {}) {
  const summary = (text) => {
    if (!env.GITHUB_STEP_SUMMARY) return;
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); } catch { /* summary is a nicety */ }
  };
  const say = (decision, fields) => {
    const line = decisionLine(decision, fields);
    log(line);
    summary(`\`${line}\``);
  };
  // Every token in the environment is taken out of any GitHub error text before it is printed.
  const scrub = (text) => {
    let out = String(text ?? "");
    for (const [k, v] of Object.entries(env ?? {})) {
      const value = String(v ?? "").trim();
      if (value && /^(FLOW_ROUTINE_\w+_TOKEN|GITHUB_TOKEN)$/.test(k)) out = out.split(value).join("***");
    }
    return out.split("\n")[0];
  };
  // flow-0211: the skip stays green, but the owner hears about it, once, in an issue.
  const noRoutine = async (tier, taskId) => {
    say("skipped", { reason: `no-routine-for-${tier}`, task: taskId });
    if (!github) {
      summary(`The ${tier} tier has no routine. No issue was written: this run has no GITHUB_TOKEN or GITHUB_REPOSITORY.`);
      return 0;
    }
    try {
      const ids = readyIdsForTier(tasksDir, tier);
      const r = await ensureNoRoutineIssue(github, tier, ids.length ? ids : [taskId]);
      summary(`The ${tier} tier has no routine. Issue ${r.action}: ${r.url ?? `#${r.number}`}`);
    } catch (e) {
      const why = scrub(e?.message ?? e);
      summary(`The ${tier} tier has no routine. The issue could not be written: ${why}`);
      error(`::warning::flow-dispatch: the no-routine issue for the ${tier} tier could not be written: ${why}`);
    }
    return 0;
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
  if (!routineFor(tier, env)) return noRoutine(tier, taskId);

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
  if (!routine) return noRoutine(tier, taskId);
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
  // flow-0211: the tier works now, so its no-routine issue, if one is open, is closed. Best effort:
  // the task has already been fired, and nothing here can change the run's result.
  if (github) {
    try {
      const r = await closeTierIssue(github, tier, taskId);
      if (r.action === "closed") summary(`Closed the ${tier} no-routine issue: ${r.url ?? `#${r.number}`}`);
    } catch (e) {
      summary(`The ${tier} no-routine issue could not be checked or closed: ${scrub(e?.message ?? e)}`);
    }
  }
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
  const override = (process.env.FLOW_DISPATCH_FLOW_DIR ?? "").trim();
  const flowDir = override
    ? resolvePath(override)
    : resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(await runDispatchCli(process.argv.slice(2), { flowDir }));
}
