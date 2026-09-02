#!/usr/bin/env node
// pick-task.mjs — the queue-runner's task selector. Pure, zero-dependency (Node >= 18).
//
// Implements step 1 of the Flow loop (CLAUDE.md): pick the highest-priority `ready`
// task whose declared `touches` blast radius does NOT overlap any currently
// `in_progress` task. Prints that task's id to stdout and nothing else, or prints
// nothing (exit 0) when there is no eligible task.
//
//   node .flow/bin/pick-task.mjs        # prints e.g. "CAN-42" or nothing
//
// Two callers:
//   - the scheduled queue-runner workflow reads this id to dispatch a fresh worker;
//   - a human runs it at the repo root to sanity-check "what's next" against the board.
//
// Selection order: lowest `priority` NUMBER wins — P1 is most urgent, matching the
// board's ascending sort and the PRI palette. Ties break by the task id's numeric
// suffix ascending (older sequential ids first), then lexically by id. Determinism is
// the point: two queue-runner ticks racing on the same store must agree on the same
// next task, or the first-push-wins claim degenerates into churn.

import { readFileSync, readdirSync } from "node:fs";
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
// Parse the YAML frontmatter we care about from a task file's text. Tolerant of the
// inline-array `touches` form and `#` trailing comments — same shape flow-doctor and
// touches-guard read. Returns null when there's no frontmatter block.
export function parseTask(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].split("#")[0].trim().replace(/^"(.*)"$/, "$1") : "";
  };
  const touchesRaw = (head.match(/^touches:\s*\[(.*?)\]/m) || [, ""])[1];
  const touches = [...touchesRaw.matchAll(/"([^"]*)"|'([^']*)'/g)]
    .map((x) => x[1] ?? x[2]).filter(Boolean);
  const id = get("id");
  if (!id) return null;
  return { id, status: get("status"), priority: parseInt(get("priority"), 10), touches };
}

// The literal path prefix of a glob: everything up to (not including) the first wildcard.
// "src/components/signup/**" -> "src/components/signup/", "app/vercel.json" -> "app/vercel.json",
// "**" -> "". Overlap reasoning works off these prefixes — exact enough for the path-glob
// vocabulary task files use, without pulling in a glob-intersection library.
export function staticPrefix(glob) {
  const star = glob.indexOf("*");
  return star === -1 ? glob : glob.slice(0, star);
}

// Path-prefix test at a segment boundary: is `a` a prefix of `b` such that they share a
// directory lineage? "src/" ⊑ "src/lib/x.ts" (true), "src" ⊑ "src/lib" (true), but
// "src/lib/a.ts" ⋢ "src/lib/ab.ts" (false — not a segment boundary).
function isPathPrefix(a, b) {
  if (a === "") return true;            // "" comes from "**" — matches everything
  if (!b.startsWith(a)) return false;
  return a === b || a.endsWith("/") || b[a.length] === "/";
}

// Two globs overlap if either's static prefix is a path-prefix of the other's. Catches the
// real cases task files produce: identical paths, a `dir/**` enclosing a file under it, and
// `**` (empty prefix) matching anything. Conservative — it may call a pair overlapping when a
// deep wildcard wouldn't actually collide, which is the safe direction for a claim guard.
export function globsOverlap(a, b) {
  const pa = staticPrefix(a), pb = staticPrefix(b);
  return isPathPrefix(pa, pb) || isPathPrefix(pb, pa);
}

// Two `touches` lists overlap if any glob pair across them overlaps.
export function touchesOverlap(aList, bList) {
  return aList.some((a) => bList.some((b) => globsOverlap(a, b)));
}

// Pure selector: given the parsed tasks, return the id of the task to work next, or null.
// A `ready` task is eligible unless its touches overlap any `in_progress` task's touches.
export function pickTask(tasks) {
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const numId = (id) => { const m = String(id).match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : Infinity; };
  const pri = (t) => (Number.isFinite(t.priority) ? t.priority : 999);

  const eligible = tasks
    .filter((t) => t.status === "ready")
    .filter((t) => !inProgress.some((p) => touchesOverlap(t.touches, p.touches)))
    .sort((a, b) => pri(a) - pri(b) || numId(a.id) - numId(b.id) || String(a.id).localeCompare(b.id));

  return eligible.length ? eligible[0].id : null;
}

// Read and parse every task file in a tasks directory (skips _TEMPLATE.md and non-.md).
export function readTasks(tasksDir) {
  const out = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (t) out.push(t);
  }
  return out;
}

// ── CLI ── prints the chosen id (or nothing). Always exits 0; "no task" is not an error.
if (__isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const id = pickTask(readTasks(join(flowDir, "tasks")));
  if (id) process.stdout.write(id + "\n");
  process.exit(0);
}
