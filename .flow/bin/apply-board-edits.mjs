#!/usr/bin/env node
// apply-board-edits.mjs — the ONLY writer of task frontmatter from a board edit.
//
// The board (.flow/board.html) never edits task files. When the human drags or
// reprioritises cards and hits "Apply edits", the board writes .flow/board-edits.json:
//
//   { "generated": "<iso>", "updates": [ { "id": "PROJ-0001", "status": "in_progress", "priority": 2 }, ... ] }
//
// This module reads that file and patches ONLY the `status` and `priority` lines in the
// matching task's frontmatter — nothing else is touched, so the files stay canonical and
// the diff is reviewable in git. There is no clipboard step and no backend.
//
// It is also reused by the flow-done and flow-status workflows, which own the PR-event
// transitions (open -> in_review with branch/pr, close-unmerged -> ready, merge -> done).
//
// CLI usage:
//   node .flow/bin/apply-board-edits.mjs                 # reads .flow/board-edits.json
//   node .flow/bin/apply-board-edits.mjs path/to.json    # explicit edits file
//   node .flow/bin/apply-board-edits.mjs --keep          # don't delete the edits file after applying
//
// Programmatic usage:
//   import { applyEdits } from "./apply-board-edits.mjs";
//   const { applied, problems } = applyEdits({ tasksDir, updates });   // or { editsPath }
//
// Zero dependencies (Node >= 18). Exits non-zero on any failure so it can run in CI/hooks.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


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
export const STATUSES = new Set(["ready", "in_progress", "in_review", "done", "blocked"]);

// Patch a single frontmatter field in a task-file's text, touching nothing else.
function replaceField(block, key, value) {
  const re = new RegExp(`^(${key}:)[^\\n]*`, "m");
  return re.test(block) ? block.replace(re, `$1 ${value}`) : `${block}\n${key}: ${value}`;
}

const STRING_FIELDS = ["owner", "branch", "pr"];   // quoted-string frontmatter fields we may patch

// Apply a list of {id, status?, priority?, owner?, branch?, pr?} updates to the task files
// in tasksDir. Returns { applied, problems[], warnings[] }. Only writes the matched task files.
// A missing task file is a WARNING, not a problem (live-validation finding, 2026-06-05): the
// flow-status/flow-done workflows legitimately fire on branches whose id has no task file —
// that must no-op green, not fail the run. Malformed input stays a problem.
export function applyEdits({ tasksDir, updates }) {
  if (!Array.isArray(updates)) throw new Error("updates must be an array");

  // Index task files by their frontmatter id.
  const byId = new Map();
  for (const name of readdirSync(tasksDir)) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const file = join(tasksDir, name);
    const m = readFileSync(file, "utf8").match(/^id:\s*"?([^"\n]+)"?/m);
    if (m) byId.set(m[1].trim(), file);
  }

  let applied = 0;
  const problems = [];
  const warnings = [];

  for (const u of updates) {
    if (!u || !u.id) { problems.push("skipped an update with no id"); continue; }
    const file = byId.get(u.id);
    if (!file) { warnings.push(`${u.id}: no task file found — skipped (no-op)`); continue; }

    if (u.status !== undefined && !STATUSES.has(u.status)) {
      problems.push(`${u.id}: illegal status "${u.status}"`); continue;
    }
    if (u.priority !== undefined && !(Number.isInteger(u.priority) && u.priority >= 1 && u.priority <= 5)) {
      problems.push(`${u.id}: priority must be an integer 1-5, got ${u.priority}`); continue;
    }
    const badString = STRING_FIELDS.find(k =>
      u[k] !== undefined && (typeof u[k] !== "string" || /["\n]/.test(u[k])));
    if (badString) { problems.push(`${u.id}: ${badString} must be a plain string (no quotes/newlines)`); continue; }

    const src = readFileSync(file, "utf8");
    const end = src.indexOf("\n---", 3);              // close of the leading frontmatter block
    if (!src.startsWith("---") || end === -1) { problems.push(`${u.id}: malformed frontmatter`); continue; }

    let head = src.slice(0, end);
    const body = src.slice(end);
    if (u.status !== undefined)   head = replaceField(head, "status", `"${u.status}"`);
    if (u.priority !== undefined) head = replaceField(head, "priority", String(u.priority));
    for (const k of STRING_FIELDS) {
      if (u[k] !== undefined) head = replaceField(head, k, `"${u[k]}"`);
    }

    const next = head + body;
    if (next !== src) { writeFileSync(file, next); applied++; }
  }

  return { applied, problems, warnings };
}

// ── CLI wrapper (only runs when invoked directly, not when imported) ──
function main(argv) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");   // .flow/
  const tasksDir = join(flowDir, "tasks");

  const args = argv.slice(2);
  const keep = args.includes("--keep");
  const editsPath = resolve(args.find(a => !a.startsWith("--")) || join(flowDir, "board-edits.json"));

  const die = (msg) => { console.error(`apply-board-edits: ${msg}`); process.exit(1); };

  if (!existsSync(editsPath)) die(`no edits file at ${editsPath}`);

  let payload;
  try { payload = JSON.parse(readFileSync(editsPath, "utf8")); }
  catch (e) { die(`could not parse ${editsPath}: ${e.message}`); }

  const updates = Array.isArray(payload) ? payload : payload.updates;
  if (!Array.isArray(updates)) die("edits file has no `updates` array");

  const { applied, problems, warnings } = applyEdits({ tasksDir, updates });

  if (warnings.length) console.warn("apply-board-edits: warnings:\n  - " + warnings.join("\n  - "));
  if (problems.length) console.error("apply-board-edits: problems:\n  - " + problems.join("\n  - "));
  console.log(`apply-board-edits: applied ${applied} update(s) from ${editsPath}`);

  if (!keep && problems.length === 0) unlinkSync(editsPath);   // consume it so it can't reapply

  console.log("Next: regenerate the board (board-builder) so the view matches the files.");
  process.exit(problems.length ? 1 : 0);
}

if (__isMain) main(process.argv);
