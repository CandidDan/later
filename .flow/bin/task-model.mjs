#!/usr/bin/env node
// task-model.mjs — which model, at which effort, builds a task; and moving a failed task up a tier.
//
// THE PROBLEM IT SOLVES (flow-0083). The worker used to run on one literal model, whatever the
// task needed. Most tasks — tight criteria, small `touches`, an existing pattern to
// follow — are Sonnet work; a few need Opus or Fable. The orchestrator who writes the task makes
// that call once, with a reason, in the task's own frontmatter:
//
//   model: "opus"                 # haiku | sonnet | opus | fable    (unset: sonnet)
//   effort: "high"                # low | medium | high | max         (unset: medium)
//   model_reason: "edits the recover sweep and the store's state transitions"
//
// And because a model rarely knows when it is out of its depth, a failed attempt moves the task
// up a tier ON ITS OWN (`escalate`), rather than waiting for the weaker model to ask for help:
//
//   haiku → sonnet → opus → fable → (a `decision` ask: split the task)
//
// Three triggers call `escalate`: flow-recover resetting a stranded claim that pushed nothing
// (flow-0174, which took this over from the retired queue-runner), a PR closed unmerged, and the
// worker itself, which blocks with `Recommend: re-run on <tier>` (that one is protocol, not code). Every escalation is a TASK-STATE change, so it is a commit to the task file on
// `main`, never on a branch.
//
// FOUR DECISIONS, MADE ONCE:
//
//   1. `TIERS` IS THE ONLY TIER → MODEL-ID TABLE IN THE REPO. Full IDs, never aliases: an alias
//      resolves through whatever CLI the action pin installs, which is how workers silently ran a
//      generation behind (flow-0140). A new model is a one-line edit here, and
//      `task-model.test.mjs` fails if a second table appears in a workflow or a helper.
//   2. NEVER SILENTLY FALL BACK. A value outside the lists, or a `model`/`effort` with no
//      `model_reason`, FAILS the run naming the field and what is allowed. A typo that quietly
//      built on the default would spend a run on the wrong model with nothing saying so.
//   3. EFFORT IS A REAL FLAG. Claude Code 2.1.293 (the CLI flow-0140's v1.0.245 pin installs)
//      accepts `--effort <level>` — verified against that version's own `claude --help`, which
//      lists `low, medium, high, xhigh, max`. Flow exposes the four the rubric uses.
//   4. AT THE TOP TIER, ESCALATION ASKS INSTEAD. A task that fails on Fable is not a model
//      problem, so `model` is left alone and the human gets a `decision` ask recommending a split.
//      Its id is stable across repeats (the event rides in the recommendation, which `asks.mjs`
//      leaves out of the id), so a task that keeps failing carries one ask, not a pile.
//
// Pure core, thin CLI. Zero dependencies beyond `asks.mjs` (Node >= 18).

import { readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";

import { askId, parseAsk } from "./asks.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Through a
// symlink they differ and the CLI block silently never runs — the worker step would then get no
// `--model` at all. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

/** Tier → full model ID. THE ONLY SUCH TABLE IN THE REPO (decision 1). Order is escalation order. */
export const TIERS = Object.freeze({
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
});
export const TIER_ORDER = Object.freeze(Object.keys(TIERS));
export const EFFORTS = Object.freeze(["low", "medium", "high", "max"]);
export const DEFAULT_TIER = "sonnet";
export const DEFAULT_EFFORT = "medium";
export const DEFAULT_REASON = "default";

// ── frontmatter, read and written field by field ──────────────────────────
// The frontmatter is the text between the opening `---` and its closing fence. Fields are read
// and rewritten in place, so a task's comments, key order and body are never re-serialised.

function frontmatterBounds(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? null : { start: 0, end };
}

// A one-line scalar: strip a trailing ` # comment` outside quotes, then the quotes themselves.
export function scalar(raw) {
  let s = String(raw ?? "");
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) { s = s.slice(0, i); break; }
  }
  const v = s.trim();
  const dq = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (dq) return dq[1].replace(/\\(["\\])/g, "$1");
  const sq = v.match(/^'((?:[^']|'')*)'$/);
  if (sq) return sq[1].replace(/''/g, "'");
  return v;
}

/** The value of a top-level scalar field in the frontmatter, or "" when it is absent. */
export function readField(text, key) {
  const b = frontmatterBounds(text);
  if (!b) return "";
  const m = text.slice(0, b.end).match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? scalar(m[1]) : "";
}

const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** Set a top-level scalar field, in place if present, otherwise appended before the closing fence. */
export function writeField(text, key, value) {
  const b = frontmatterBounds(text);
  if (!b) throw new Error("task has no frontmatter");
  const head = text.slice(0, b.end);
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${quote(value)}`;
  if (re.test(head)) return head.replace(re, line) + text.slice(b.end);
  return `${head}\n${line}${text.slice(b.end)}`;
}

/** The task's `asks:` list as strings — inline (`["a"]`) or multi-line (`- "a"`). */
export function readAsks(text) {
  const b = frontmatterBounds(text);
  if (!b) return [];
  const lines = text.slice(0, b.end).split("\n");
  const i = lines.findIndex((l) => /^asks:/.test(l));
  if (i === -1) return [];
  const inline = lines[i].replace(/^asks:\s*/, "");
  if (inline.trim().startsWith("[")) {
    return [...inline.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'/g)]
      .map((m) => (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2].replace(/''/g, "'")));
  }
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^\s+-\s*(.*)$/);
    if (!m) break;
    out.push(scalar(m[1]));
  }
  return out;
}

/** Replace the whole `asks:` field with `asks` in multi-line form (or append it if absent). */
export function writeAsks(text, asks) {
  const b = frontmatterBounds(text);
  if (!b) throw new Error("task has no frontmatter");
  const lines = text.slice(0, b.end).split("\n");
  const block = ["asks:", ...asks.map((a) => `  - ${quote(a)}`)];
  const i = lines.findIndex((l) => /^asks:/.test(l));
  if (i === -1) return [...lines, ...block].join("\n") + text.slice(b.end);
  let j = i + 1;
  if (!lines[i].replace(/^asks:\s*/, "").trim().startsWith("[")) {
    while (j < lines.length && /^\s+-\s/.test(lines[j])) j++;
  }
  lines.splice(i, j - i, ...block);
  return lines.join("\n") + text.slice(b.end);
}

// ── resolve ────────────────────────────────────────────────────────────────

/**
 * Which model and effort build this task. `task` is the task file's text, or an object carrying
 * `model`, `effort` and `model_reason`. Returns `{ tier, id, effort, reason }`; THROWS naming the
 * field and its allowed values on anything it cannot honour (decision 2).
 */
export function resolve(task) {
  const get = (k) => (typeof task === "string" ? readField(task, k) : String(task?.[k] ?? "")).trim();
  const model = get("model");
  const effort = get("effort");
  const reason = get("model_reason");

  if (model && !TIERS[model]) {
    throw new Error(`model: "${model}" is not a tier. Allowed values: ${TIER_ORDER.join(", ")} ` +
      `(or leave it unset for ${DEFAULT_TIER}).`);
  }
  if (effort && !EFFORTS.includes(effort)) {
    throw new Error(`effort: "${effort}" is not an effort level. Allowed values: ${EFFORTS.join(", ")} ` +
      `(or leave it unset for ${DEFAULT_EFFORT}).`);
  }
  if ((model || effort) && !reason) {
    throw new Error(`model_reason is missing: a task that sets ${model ? "model" : "effort"} must say why ` +
      `in model_reason (one line), so a departure from ${DEFAULT_TIER}/${DEFAULT_EFFORT} is a reasoned call.`);
  }
  const tier = model || DEFAULT_TIER;
  return {
    tier,
    id: TIERS[tier],
    effort: effort || DEFAULT_EFFORT,
    reason: model || effort ? reason : DEFAULT_REASON,
  };
}

/** The exact CLI arguments for the worker's `claude_args`. */
export function cliArgs(resolved) {
  return ["--model", resolved.id, "--effort", resolved.effort];
}

/** The step-summary line: tier, model ID, effort and reason. */
export function summaryLine(taskId, r) {
  return `### Worker model for \`${taskId}\`\n\n` +
    `- tier: \`${r.tier}\`\n- model: \`${r.id}\`\n- effort: \`${r.effort}\`\n- reason: ${r.reason}\n`;
}

// ── escalate ───────────────────────────────────────────────────────────────

/** The `decision` ask a task gets when it fails at the top tier. Its id never depends on `event`. */
export function topTierAsk(event) {
  return `decision: this task failed on the top tier (fable) and cannot escalate further; ` +
    `split it or re-scope it? Recommend: split the task into smaller tasks (latest failure: ${event})`;
}

/**
 * Has this task already been escalated for `event`? The `--once` guard: a workflow that may apply
 * the same escalation twice (a retried push, a follow-up step) must move the task ONE tier per
 * failure, not one per attempt. True when `model_reason` names the event, or the top-tier
 * `decision` ask does.
 */
export function recordsEvent(text, event) {
  if (readField(text, "model_reason").includes(`escalated after ${event} (was `)) return true;
  return readAsks(text).some((a) => a.endsWith(`(latest failure: ${event})`));
}

/**
 * The task text with `model` one tier up and `model_reason: "escalated after <event> (was <tier>)"`.
 * At `fable`, `model` is left alone and a `decision` ask is added (or refreshed) instead.
 * Throws on a task `resolve` would reject: escalating from an unreadable tier would be a guess.
 */
export function escalate(text, event, { once = false } = {}) {
  if (once && recordsEvent(text, event)) return text;
  const { tier } = resolve(text);
  const next = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
  if (next) {
    return writeField(writeField(text, "model", next), "model_reason", `escalated after ${event} (was ${tier})`);
  }
  const ask = topTierAsk(event);
  const id = parseAsk(ask).id;
  const kept = readAsks(text).filter((a) => {
    const p = parseAsk(a);
    return p.error ? true : p.id !== id;
  });
  return writeAsks(text, [...kept, ask]);
}

// ── store I/O ──────────────────────────────────────────────────────────────

/** The path of the task file whose frontmatter id is `id`, or null. */
export function findTaskFile(tasksDir, id) {
  let names;
  try { names = readdirSync(tasksDir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const path = join(tasksDir, name);
    if (readField(readFileSync(path, "utf8"), "id") === id) return path;
  }
  return null;
}

// `--flag value`, or a bare `--flag` (followed by another flag, or last) meaning "true".
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { out._.push(argv[i]); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[argv[i].slice(2)] = "true";
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}

const truthy = (v) => v === "1" || v === "true";

/**
 * The CLI, shared with canonical's adapter so the two shells cannot drift. Returns the exit code.
 *
 *   resolve  --task-id X                  emit claude args (+ $GITHUB_OUTPUT, step summary)
 *   escalate --task-id X --event "..." [--once]
 *                                         rewrite the task file one tier up (--once: unless
 *                                         the task already records this event)
 */
export function runCli(argv, tasksDir, io = {}) {
  const { log = console.log, error = console.error, env = process.env } = io;
  const flags = parseFlags(argv);
  const mode = flags._[0];
  const taskId = String(flags["task-id"] ?? "");
  const output = (pairs) => {
    for (const [k, v] of Object.entries(pairs)) log(`${k}=${v}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
  };
  if (!["resolve", "escalate"].includes(mode)) {
    error("usage: task-model.mjs resolve|escalate --task-id <id> [...]");
    return 2;
  }
  const file = findTaskFile(tasksDir, taskId);
  if (!file) {
    error(`::error::task-model: no task with id "${taskId}" in ${tasksDir}`);
    return 1;
  }
  const text = readFileSync(file, "utf8");
  try {
    if (mode === "resolve") {
      const r = resolve(text);
      output({ args: cliArgs(r).join(" "), tier: r.tier, model: r.id, effort: r.effort });
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryLine(taskId, r) + "\n");
      return 0;
    }
    const event = String(flags.event ?? "").trim();
    if (!event) { error("::error::task-model escalate: --event is required"); return 2; }
    const once = truthy(flags.once);
    if (once && recordsEvent(text, event)) {
      log(`${taskId}: already escalated after ${event} — nothing to do`);
      return 0;
    }
    const before = resolve(text).tier;
    const after = escalate(text, event, { once });
    writeFileSync(file, after);
    const now = readField(after, "model") || before;
    log(now === before
      ? `${taskId}: already at the top tier (${before}) — added a decision ask recommending a split`
      : `${taskId}: escalated ${before} -> ${now} after ${event}`);
    return 0;
  } catch (e) {
    error(`::error::task-model (${taskId}): ${e.message}`);
    return 1;
  }
}

// ── CLI ── In an adopting repo this file is copied to `.flow/bin/`, so the store is that repo's
// `.flow/tasks/`. In canonical it would be the template's fixture store — canonical runs its
// adapter, never this file directly.
if (__isMain) {
  const tasksDir = join(resolvePath(dirname(fileURLToPath(import.meta.url)), ".."), "tasks");
  process.exit(runCli(process.argv.slice(2), tasksDir));
}
