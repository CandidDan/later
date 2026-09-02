#!/usr/bin/env node
// touches-guard.mjs — enforces the task's declared blast radius.
//
// `touches` was added for concurrency (skip a ready task whose globs overlap an in_progress
// one), but nothing mechanically checked that a PR's diff actually STAYS within it — only the
// fallible code-reviewer agent. This guard closes that gap: on a task-carrying PR, every changed
// file must match the task's `touches` globs, or the gate fails. (Found on CAN-30's first run:
// the worker drifted into a file the task said not to touch and only the agent might have
// caught it.)
//
// Companion to the store-guard (which owns `.flow/`): this guard ignores `.flow/**` and judges
// only feature files. A task that legitimately needs a wider radius declares it in `touches`
// (or `touches: ["**"]` to opt out entirely). Discovering mid-build that you need more is a
// scope signal — block and let the orchestrator widen `touches` on main, don't drift silently.
//
// The task id is resolved from the branch OR the PR title (`[<id>] …`), so a PR from a cloud
// session forced onto a non-`flow/` branch is still scope-checked rather than waved through.
//
//   node .flow/bin/touches-guard.mjs                 # CI: derives branch, base, changed files
//   BASE_REF=origin/main HEAD_REF=flow/CAN-30-x node .flow/bin/touches-guard.mjs
//   BASE_REF=origin/main HEAD_REF=claude/xyz PR_TITLE='[CAN-30] …' node .flow/bin/touches-guard.mjs
//
// Zero deps (Node >= 18). Exits non-zero when a changed file is outside touches.
//
// ── The decision line (flow-0008) ──────────────────────────────────────────────────────
// Every run — enforcing OR skipping — prints exactly one line beginning with
// `touches-guard: decision=`. `_flow-gates.yml` captures the guard's output and fails the job
// when that line is absent, so "the guard printed nothing" can no longer be read as "the guard
// found nothing wrong". That distinction is the whole bug this closes: the guard used to FAIL
// OPEN, exiting 0 with scope enforcement silently off while the gate went green.
//
// The line is a CONTRACT between this file and the gate, not log prose. Changing its prefix or
// its `decision=` / `reason=` vocabulary is a breaking change to CI in every adopting repo.
// The human-readable lines around it stay free to reword; those are not parsed.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaskId } from "./parse-task-id.mjs";


import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED.
// When the script is reached through a symlink they differ, the comparison is false, and the
// CLI block below silently never runs — no output, exit 0, nothing to debug. macOS hits this
// routinely because os.tmpdir() (/var/folders/...) is a symlink to /private/var/folders/...,
// and any symlinked checkout or bind-mount does the same. For touches-guard that means the
// scope check silently does not run and the gate goes green: it fails OPEN, which is the
// wrong direction for a guard. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------
// Translate a path glob to an anchored RegExp. Supports: `**` (any path span, incl. /),
// `*` (anything except /), and literal `.`/path chars. Mirrors the globs used in task files
// (e.g. "src/components/signup/**", "src/lib/validation/email.*", "app/vercel.json").
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// Pure core: which changed files fall outside the declared touches globs.
// `.flow/**` is excluded (the store-guard's domain). `["**"]` allows everything.
export function checkTouches({ changedFiles, touches }) {
  const candidates = changedFiles.filter((f) => !f.startsWith(".flow/"));
  if (touches.includes("**")) return { outside: [], checked: candidates.length };
  const res = touches.map(globToRegExp);
  const outside = candidates.filter((f) => !res.some((r) => r.test(f)));
  return { outside, checked: candidates.length };
}

// Parse a task file's `touches` from its YAML frontmatter. Handles BOTH shapes the
// store actually uses, returning the same string[]:
//   inline:      touches: ["a/**", "b.json"]
//   multi-line:  touches:
//                  - "a/**"
//                  - 'b.json'
// A genuinely empty declaration (`touches: []`, or no key) returns []. Dependency-free
// (no YAML lib) — a tolerant scan of the two shapes the task files use is enough.
// (CAN-57: the multi-line form previously never matched, silently disabling the guard
// for the entire dashboard task family.)
export function parseTouches(src) {
  // Only look inside the YAML frontmatter (between the first two `---` fences), never the
  // body — a task's prose can legitimately contain a `touches:` line (e.g. a code example,
  // as CAN-57's own task file does). Falls back to the whole string if no fence is found.
  const fence = src.match(/^---\n([\s\S]*?)\n---/);
  const fm = fence ? fence[1] : src;

  // Inline array — the `s` flag lets the bracket span lines (`touches: [\n "a",\n ]`).
  const inline = fm.match(/^touches:\s*\[(.*?)\]/ms);
  if (inline) {
    return [...inline[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]).filter(Boolean);
  }
  // Multi-line YAML list: a bare `touches:` line followed by `  - <glob>` items.
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => /^touches:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue; // tolerate blank + full-line comments
    const item = line.match(/^\s*-\s+(.*\S)\s*$/);
    if (!item) break; // a non-item line is the next key — the list has ended
    const raw = item[1];
    // Quoted value: take what's inside the quotes, ignoring any trailing ` # comment`.
    // Unquoted value: strip a trailing YAML comment (whitespace + `#…`).
    const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
    const value = quoted ? (quoted[1] ?? quoted[2]) : raw.replace(/\s+#.*$/, "").trim();
    if (value) out.push(value);
  }
  return out;
}

// Read a task file's `touches` list from YAML frontmatter (both inline + multi-line forms).
function readTouches(file) {
  return parseTouches(readFileSync(file, "utf8"));
}

// The task file in `tasksDir` whose frontmatter `id` is `id`, or null. Exported so an adapter
// (canonical's `.flow/bin/` thin wrapper) can reuse the scan instead of re-implementing it.
export function findTaskFile(tasksDir, id) {
  for (const name of readdirSync(tasksDir)) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const file = join(tasksDir, name);
    const m = readFileSync(file, "utf8").match(/^id:\s*"?([^"\n]+)"?/m);
    if (m && m[1].trim() === id) return file;
  }
  return null;
}

// ── The decision line ────────────────────────────────────────────────────────────────────
// A fixed token the gate anchors on. Kept as an exported constant so the guard, its tests and
// (via import) any adapter all name the same string — a typo becomes a test failure here
// rather than a silently-skipped assertion in CI.
export const DECISION_PREFIX = "touches-guard: decision=";

// The two decisions and the reasons each admits. Enumerated rather than free text so a new
// exit path cannot invent an unrecognised reason without this list changing with it.
export const DECISIONS = Object.freeze({
  enforced: ["in-scope", "out-of-scope"],
  skipped: ["no-task-id", "no-task-file", "no-touches-declared"],
});

// Render the single decision line. Shape (one line, no leading whitespace, stable key order):
//   touches-guard: decision=enforced reason=out-of-scope task=flow-0008 checked=4 globs=3 outside=1
//   touches-guard: decision=skipped reason=no-task-id task=-
// `task=-` rather than an empty value, so every field is present on every line and a parser
// never has to distinguish "absent" from "empty".
export function decisionLine({ decision, reason, id = "", checked = 0, globs = 0, outside = 0 }) {
  const reasons = DECISIONS[decision];
  if (!reasons) throw new Error(`touches-guard: unknown decision '${decision}'`);
  if (!reasons.includes(reason)) {
    throw new Error(`touches-guard: reason '${reason}' is not valid for decision '${decision}'`);
  }
  return `${DECISION_PREFIX}${decision} reason=${reason} task=${id || "-"} ` +
    `checked=${checked} globs=${globs} outside=${outside}`;
}

// ── The guard proper ─────────────────────────────────────────────────────────────────────
// Shared by this file's CLI and by canonical's adapter, so there is exactly one place where a
// decision is reached and exactly one place where it is announced. `tasksDir` is the only thing
// that differs between the two callers — the store an adapter resolves is its whole reason to
// exist (see the adapter's own header).
//
// Returns the process exit code. EVERY return path prints a decision line first, including the
// failure path: the gate must be able to tell "enforced and rejected" from "never ran", and
// those look identical from an exit code alone.
export function runGuard({ tasksDir, env = process.env, log = console.log, err = console.error }) {
  const headRef = env.HEAD_REF
    || execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
  const prTitle = env.PR_TITLE || "";

  // Branch first, PR title second — the same resolution flow-status/flow-done use (CAN-52).
  // Matching on the branch alone meant every cloud-session PR (forced onto `claude/…` by the
  // platform) skipped the guard silently: scope enforcement was off for exactly the sessions
  // most likely to drift, and the gate went green saying nothing.
  const id = parseTaskId(headRef, prTitle);
  if (!id) {
    log(`touches-guard: no task id in branch '${headRef}' or title '${prTitle}' — skipping.`);
    log(decisionLine({ decision: "skipped", reason: "no-task-id" }));
    return 0;
  }

  const file = findTaskFile(tasksDir, id);
  if (!file) {
    log(`touches-guard: no task file for ${id} — skipping (store-guard / review will catch oddities).`);
    log(decisionLine({ decision: "skipped", reason: "no-task-file", id }));
    return 0;
  }

  const touches = readTouches(file);
  if (touches.length === 0) {
    err(`touches-guard: ${id} declares no touches — cannot enforce a blast radius. ` +
      `flow-doctor flags this; add touches to make scope checkable. Passing for now.`);
    log(decisionLine({ decision: "skipped", reason: "no-touches-declared", id }));
    return 0;
  }

  const base = env.BASE_REF || "origin/main";
  const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`])
    .toString().split("\n").map((s) => s.trim()).filter(Boolean);

  const { outside, checked } = checkTouches({ changedFiles, touches });
  log(`touches-guard: ${id} — ${checked} feature file(s) checked against ${touches.length} glob(s).`);
  log(decisionLine({
    decision: "enforced",
    reason: outside.length ? "out-of-scope" : "in-scope",
    id, checked, globs: touches.length, outside: outside.length,
  }));

  if (outside.length) {
    err("::error::Changed files fall outside this task's declared `touches`:");
    for (const f of outside) err(`  outside touches: ${f}`);
    err("Either narrow the change to the declared scope, or — if the wider radius is " +
      "real — block the task and have the orchestrator update `touches` on main before continuing. " +
      "Do not widen scope silently.");
    return 1;
  }
  log("touches-guard: all changed files are within scope ✓");
  return 0;
}

// ── CLI ── one call, so the CLI shell holds no decision logic of its own.
if (__isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(runGuard({ tasksDir: join(flowDir, "tasks"), env: process.env }));
}
