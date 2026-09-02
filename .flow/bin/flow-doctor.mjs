#!/usr/bin/env node
// flow-doctor.mjs — drift detection for the work store, back-ported from the canary repo's
// `state:check` pattern: a validated store beats a trusted one. Checks that the task
// files are internally consistent and that the board snapshot hasn't drifted from them.
// Run on demand or in CI (flow-tooling job). Exits non-zero on PROBLEMS; WARNINGS report only.
//
//   node .flow/bin/flow-doctor.mjs
//
// PROBLEMS (exit 1): malformed frontmatter · missing required fields · illegal status ·
//   duplicate ids · in_review without pr/branch · blocked without blocked_reason ·
//   in_progress without owner/started · two in_progress tasks with overlapping touches (the
//   atomic-claim rule was bypassed) · a declared, CALIBRATED source_root that's missing/uncovered,
//   or a top-level source tree no calibrated source_root covers (the gate-coverage floor — see
//   below) · a task file present on disk but not committed (the uncommitted-task guard — see
//   below) · a ready task whose body doesn't meet the readiness bar, or whose `serves` doesn't
//   resolve against VISION.md (see below).
// WARNINGS (exit 0): ready task with owner set · ready task with empty touches (concurrency
//   relies on it) · live tasks with overlapping touches (they can't run in parallel — sequence
//   them; don't call them parallel-safe) · board snapshot ids/statuses drifted from the files ·
//   no source_roots declared yet (adoption nudge) · a source_root still holding the shipped
//   REPLACE-ME placeholder in `path` or `check` (uncalibrated, not stale — see below) · Flow
//   infra behind canonical (only when FLOW_CANONICAL_VERSION is set — see "version drift"
//   below) · a task touching a top-level directory that doesn't exist yet (new-subsystem tell) ·
//   no VISION.md (vision layer inactive) · a retired goal, or an unresolvable `serves` on a
//   non-ready task.
// NOTES (exit 0): a check that was skipped because its precondition wasn't met (e.g. not run
//   inside a git work tree, so the uncommitted-task guard can't read `git status`).
//
// UNCOMMITTED-TASK GUARD (CAN-41). A task isn't in the store until it's committed to main —
// the store IS the committed `.flow/tasks/` on main, and concurrency depends on every session
// seeing the same committed state. A task file left uncommitted (or with uncommitted edits) is
// invisible to other sessions and to the board: it looks claimed/done locally but isn't. This
// fails on any `.flow/tasks/*.md` that `git status` reports as untracked or modified. Skipped
// (a note, not a failure) outside a git work tree, so unit fixtures and tarball checkouts are
// unaffected.
//
// VERSION DRIFT. Flow infra is authored in canonical (CandidDan/flow) and repos adopt it, so a
// repo can silently fall behind. Set FLOW_CANONICAL_VERSION (CI can derive it from
// `git ls-remote --tags https://github.com/CandidDan/flow`) and this warns when the repo's
// `.flow/VERSION` stamp is older. Off by default so local runs are unchanged.
//
// READINESS BAR (flow-0010). Every property that makes a task *ready* — observable criteria, a
// stated scope, no unresolved decisions — used to be checked exactly once, by `task-writer`, which
// may never run: the ad-hoc "spec this out" path doesn't load the skill, and nothing downstream
// re-checked it. A task file with legal frontmatter and a COMPLETELY EMPTY BODY passed clean and
// got dispatched to a worker (real incident: three worker runs, ~$13 each, no PR, on a task that
// bundled four deliverables and whose "criteria" were all "the thing exists"). So the bar is
// re-applied here, mechanically, at the point a task is offered to a worker: `## Context`,
// `## Scope` and `## Acceptance criteria` present, with at least one criterion that isn't
// `_TEMPLATE.md`'s placeholder. Deliberately shallow — no LLM call, no heuristic score, no
// criteria-count threshold (a numeric cap gets *satisfied* rather than obeyed, turning one honest
// failure into several PRs that each pass their own gate). It catches a task written freehand
// that skipped the shape entirely, which is what a skipped `task-writer` produces, and no more.
// `ready` only: the bar belongs at dispatch, and must not retroactively fail history — flow-doctor
// fails store-wide, so a retroactive rule would redden every open PR in the repo at once.
//
// VISION-SERVES (flow-0010). The same bar from another angle: a task isn't ready if a fresh
// session can't say which goal the work serves. When a `VISION.md` exists at the repo root, a
// `ready` task's `serves:` must resolve to a goal id declared there. No `VISION.md` → one warning
// and nothing else, so an adopting repo without a vision stays green. Ids are extracted by line
// regex over `### G<n> — ` / `### NG<n> — ` headings, never a Markdown parser. `maintenance` is a
// reserved id that always resolves and is never declared. Resolution is mechanical only — whether
// the work *genuinely* advances the goal is flow-compass's job, advisory and out of the gate.
//
// GATE-COVERAGE FLOOR. config.yml declares `source_roots:` — each `{ path, check }` naming a
// tree and the command that parses/lints it. The gate only validates trees a command reaches,
// so an undeclared runtime is invisible until production (real incident: Deno edge functions,
// gate ran only in app/, a parse error took down inbound for ~7 days). This check makes the
// floor a *declared, ratcheting* contract and catches it drifting as the repo grows: a new
// top-level source tree that no calibrated `source_root` covers FAILS the gate until it's
// declared (or explicitly ignored). It can't prove a command truly parses a tree — it makes
// coverage explicit and reviewed, not magically complete.
//
// UNCALIBRATED VS STALE (flow-0017). A fresh scaffold still holds the shipped `REPLACE-ME`
// sentinel in `path` and/or `check` — that is "hasn't been calibrated yet", not "drifted", and
// collapsing the two into one PROBLEM makes the first thing an adopter sees after scaffolding a
// red doctor blaming them for drift they haven't had the chance to create. So a `source_root`
// whose `path` or `check` is still `REPLACE-ME` is a WARNING naming the entry, not a PROBLEM, and
// is excluded from the missing-check / stale-path checks and from covering the backstop scan
// below (an uncalibrated entry proves nothing, so it must not appear to satisfy coverage). A
// non-placeholder `path` absent from disk is still stale drift and still a PROBLEM.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { STATUSES } from "./apply-board-edits.mjs";


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
const REQUIRED = ["id", "title", "status", "priority"];

// Dirs never treated as source trees (build output, deps, VCS, Flow's own plumbing).
const ROOT_IGNORE = new Set([
  "node_modules", ".git", ".github", ".flow", ".claude", "dist", "build", "out", ".next",
  "coverage", "vendor", ".venv", "venv", "target", ".turbo", ".cache", "tmp", ".vercel",
]);
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".rb", ".java", ".kt",
  ".cs", ".php", ".ex", ".exs", ".swift", ".scala", ".dart",
]);

// The sentinel `project-template/.flow/config.yml` ships in `source_roots[].path` / `.check` —
// documented, load-bearing behaviour (`INIT.md` rule 1: never invent a config value) that marks
// a repo as not-yet-calibrated rather than drifted. Trailing slashes on `path` are stripped
// before comparing, so `"REPLACE-ME/"` and `"REPLACE-ME"` both match.
const PLACEHOLDER = "REPLACE-ME";
function isPlaceholder(v) {
  return String(v ?? "").replace(/\/+$/, "") === PLACEHOLDER;
}

// Parse the `source_roots:` block from config.yml without a YAML dep. Tolerant line scan of:
//   source_roots:
//     - path: "app/"
//       check: "npm run lint"
function parseSourceRoots(configPath) {
  if (!existsSync(configPath)) return { exists: false, declared: false, roots: [] };
  const lines = readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((l) => /^source_roots:/.test(l));
  if (start === -1) return { exists: true, declared: false, roots: [] };
  const roots = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;                     // dedent to a new top-level key → block done
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const unq = (v) => v.split("#")[0].trim().replace(/^["'](.*)["']$/, "$1");
    let m;
    if ((m = trimmed.match(/^-\s*path:\s*(.+)$/))) { cur = { path: unq(m[1]), check: "" }; roots.push(cur); }
    else if ((m = trimmed.match(/^path:\s*(.+)$/)))  { cur = { path: unq(m[1]), check: "" }; roots.push(cur); }
    else if ((m = trimmed.match(/^check:\s*(.+)$/)) && cur) { cur.check = unq(m[1]); }
  }
  return { declared: true, roots };
}

// Does any directory at or beneath `dir` (bounded depth, ignoring junk) hold a source file?
function containsSource(dir, depth = 0) {
  if (depth > 4) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !ROOT_IGNORE.has(e.name) && !e.name.startsWith(".")) {
      if (containsSource(join(dir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

// Top-level dirs (depth 1 from repo root) that hold source and aren't ignored.
function topLevelSourceDirs(repoRoot) {
  let entries;
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !ROOT_IGNORE.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => containsSource(join(repoRoot, name)));
}

// A top-level dir is covered if a declared root path equals it, sits inside it, or contains it.
function rootCovers(declaredPath, topDir) {
  const p = declaredPath.replace(/\/+$/, "");
  return p === topDir || p.startsWith(topDir + "/") || topDir.startsWith(p + "/");
}

// Parse a frontmatter list field (`touches:`, `serves:`), tolerating BOTH forms:
//   inline:      touches: ["src/**", "api/x.ts"]
//   multi-line:  touches:
//                  - "src/**"
//                  - "api/x.ts"
// (A naive same-line scan misses the multi-line form — it would read those tasks as having
// empty touches, silencing both the empty-touches warning and overlap detection below.)
function parseListField(head, key) {
  const lines = head.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (i === -1) return [];
  const inline = lines[i].replace(new RegExp(`^\\s*${key}:\\s*`), "").split("#")[0].trim();
  if (inline.startsWith("[")) return [...inline.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = t.match(/^-\s*(.+)$/);
    if (!m) break; // dedent to the next key → list done
    out.push(m[1].split("#")[0].trim().replace(/^["'](.*)["']$/, "$1"));
  }
  return out.filter(Boolean);
}

// ── readiness bar (flow-0010) ──
// Is `## <name>` present as a heading on its own line? A line scan, not a Markdown parser:
// the task body is a human document, and a parser is one more thing to break when someone
// writes it slightly differently. Tolerates `###` and leading indentation.
function hasSection(body, name) {
  return new RegExp(`^\\s{0,3}#{2,3}\\s+${name}\\b`, "im").test(body);
}

// The `- [ ]` / `- [x]` lines inside the Acceptance criteria section, checkbox stripped.
// Returns null when the section itself is absent (a different, more specific finding).
// The section ends at the next h1/h2 — `## Definition of done` in a template-shaped task.
function criteriaItems(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^\s{0,3}#{2,3}\s+acceptance criteria\b/i.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{0,3}#{1,2}\s+\S/.test(lines[i])) break;
    const m = lines[i].match(/^\s*[-*]\s*\[[ xX]\]\s*(.*)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// `_TEMPLATE.md` ships two criteria as placeholders. A task whose criteria are *only* those
// was never customised: the shape is present, the specification is not. Matched narrowly —
// the unedited `Given <situation>, when <action>, then <observable outcome>.` line, the bare
// `…` line, and nothing else. A real criterion may legitimately contain angle brackets (this
// very task's criteria quote `### G<n> — `), so "contains a <slot>" is not the test.
const PLACEHOLDER_CRITERION = /^given\s+<[^>]*>\s*,\s*when\s+<[^>]*>\s*,\s*then\s+<[^>]*>\s*\.?$/i;
function isPlaceholderCriterion(text) {
  const t = text.trim().replace(/\s+/g, " ");
  return t === "" || /^(…|\.{2,})$/.test(t) || PLACEHOLDER_CRITERION.test(t);
}

// The body-shape findings for one task. Pure and exported so the bar can be exercised
// directly, and so a caller (flow-compass, a pre-commit hook) can apply it without a store.
// Callers apply it to `ready` tasks only — see the READINESS BAR note at the top of the file.
export function readinessFindings(task) {
  const id = task.id;
  const body = task.body ?? "";
  if (body.trim() === "")
    return [`${id}: ready with an empty body — no ## Context, ## Scope or ## Acceptance criteria; ` +
      "an unspecified task is not ready, whatever its frontmatter says"];
  const out = [];
  for (const name of ["Context", "Scope"]) {
    if (!hasSection(body, name))
      out.push(`${id}: ready but the body has no "## ${name}" section — a worker would be guessing at it`);
  }
  const items = criteriaItems(body);
  if (items === null)
    out.push(`${id}: ready but the body has no "## Acceptance criteria" section — ` +
      "there is nothing for the worker to build against or the gate to prove");
  else if (items.length === 0)
    out.push(`${id}: "## Acceptance criteria" has no "- [ ]" items — a heading is not a contract`);
  else if (items.every(isPlaceholderCriterion))
    out.push(`${id}: acceptance criteria are still _TEMPLATE.md's placeholders — ` +
      "an uncustomised template is not a specified task");
  return out;
}

// ── new-subsystem tell (flow-0010) ──
// A `touches` glob rooted at a top-level directory that doesn't exist yet is the loudest
// mechanical signal for the failure this check came from: a task that scaffolds a whole new
// subsystem (a new app, a new service) is almost never one task, and it is exactly the shape
// that burns a worker's entire turn budget without producing a PR. A WARNING, never a
// problem — greenfield work is legitimate and no checker can tell the two apart. Globs with
// no directory component (a file at the repo root) and ROOT_IGNORE dirs are exempt.
function newSubsystemRoots(touchesList, repoRoot) {
  const out = [];
  for (const glob of touchesList ?? []) {
    if (!glob.includes("/")) continue;                       // a bare file at the repo root
    const root = staticPrefix(glob).split("/")[0];
    if (!root || ROOT_IGNORE.has(root)) continue;
    if (existsSync(join(repoRoot, root))) continue;
    if (!out.some((o) => o.root === root)) out.push({ root, glob });
  }
  return out;
}

// ── vision layer (flow-0010) ──
// Goal ids extracted by line regex, never a Markdown parser. Accepted heading forms — the
// separator may be an em dash, an en dash or a hyphen, because humans type all three and a
// mistyped dash must not silently drop a goal:
//   ### G1 — Ship the thing        ### NG2 - Not this thing
// Headings after `## Retired` keep their ids (ids are append-only and never reused) and are
// returned flagged, so a task still pointing at one gets a warning rather than an unknown-id
// failure. Anything that looks like a goal heading but doesn't parse comes back in
// `malformed`, so one mistyped heading can't vanish while the repo-level check stays quiet.
const GOAL_HEADING = /^###\s+(NG|G)(\d+)\s*[—–-]\s*(\S.*)$/i;   // greedy: no lazy backtracking
const GOALISH_HEADING = /^###\s+N?G\d+/i;
export const MAINTENANCE_SERVES = "maintenance";
export function parseVisionGoals(text) {
  const goals = new Map();
  const malformed = [];
  let retired = false;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const heading = line.match(/^#{1,2}\s+(.+?)\s*$/);   // h1 or h2; `###` can't match (no space)
    if (heading) { retired = /^retired\b/i.test(heading[1]); continue; }
    const m = line.match(GOAL_HEADING);
    if (m) {
      const id = (m[1] + m[2]).toUpperCase();
      if (!goals.has(id)) goals.set(id, { id, kind: m[1].toUpperCase() === "NG" ? "non-goal" : "goal", retired, title: m[3].trim() });
      continue;
    }
    if (GOALISH_HEADING.test(line)) malformed.push(line.trim());
  }
  return { goals, malformed };
}

// The non-wildcard leading path of a glob, trimmed to whole segments — what we compare for overlap.
//   "a/b/**" -> "a/b" · "a/b/c.ts" -> "a/b/c.ts" · "a/**/x" -> "a"
function staticPrefix(glob) {
  const i = glob.search(/[*?[\]{}]/);
  let p = i === -1 ? glob : glob.slice(0, i);
  if (i !== -1 && !p.endsWith("/")) p = p.slice(0, p.lastIndexOf("/") + 1);
  return p.replace(/\/+$/, "");
}
// Segment-aware path containment, so "app/foo" and "app/foobar" do NOT match.
function pathContains(p, q) { return p === q || q.startsWith(p + "/") || p.startsWith(q + "/"); }
// Two globs overlap if identical or one's static prefix contains the other's. Heuristic (no full
// glob-intersection), but it catches the dominant cases: an exact shared file, and nested trees.
function globsOverlap(a, b) { return a === b || pathContains(staticPrefix(a), staticPrefix(b)); }
// First overlapping (a, b) glob pair between two touches lists, or null.
function touchesOverlap(A, B) {
  for (const a of A) for (const b of B) if (globsOverlap(a, b)) return [a, b];
  return null;
}

// ── version drift (Flow infra is authored in canonical; repos adopt — this is the guard) ──
// Parse "v1.2.3" / "1.2" / "0.1.0" into numeric segments; a `v` prefix and a short form are fine.
function parseVersion(v) {
  return String(v).trim().replace(/^v/i, "").split(".").map((s) => parseInt(s, 10) || 0);
}
// -1 if a < b, 0 if equal, 1 if a > b (segment-wise, missing segments treated as 0).
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ── uncommitted-task guard (CAN-41) ──
// Pure detector: given `git status --porcelain` output and the list of on-disk task-file
// paths (repo-relative, e.g. ".flow/tasks/0099-x.md"), return the task files that are present
// but not committed — untracked or with staged/unstaged changes. `_TEMPLATE.md` is ignored;
// staged deletions (not on disk) are ignored via the `files` filter. When `files` is
// empty/omitted, no on-disk filtering is applied (so the function is unit-testable from canned
// porcelain alone).
export function findUncommittedTasks(porcelain, files) {
  const onDisk = new Set(files ?? []);
  const offending = [];
  for (const raw of String(porcelain).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length < 4) continue;
    let path = line.slice(3).trim(); // porcelain is "XY <path>"
    if (path.includes(" -> ")) path = path.split(" -> ").pop().trim(); // renames
    path = path.replace(/^"(.*)"$/, "$1"); // git quotes paths with special chars
    if (!path.startsWith(".flow/tasks/") || !path.endsWith(".md")) continue;
    if (path.endsWith("_TEMPLATE.md")) continue;
    if (onDisk.size && !onDisk.has(path)) continue; // e.g. a staged deletion
    if (!offending.includes(path)) offending.push(path);
  }
  return offending;
}

// Thin git wrapper (the only side-effecting part). Reads porcelain status scoped to
// `.flow/tasks` from the repo root. Returns `{ inRepo: false }` outside a git work tree so the
// caller can skip gracefully (a note, not a failure).
function realGitPorcelain(flowDir) {
  const repoRoot = resolve(flowDir, "..");
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (inside !== "true") return { inRepo: false, porcelain: "" };
    const porcelain = execFileSync("git", ["status", "--porcelain", "--", ".flow/tasks"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { inRepo: true, porcelain };
  } catch {
    return { inRepo: false, porcelain: "" };
  }
}

function parseTask(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  // Everything after the closing `---` line. "" when the file is frontmatter only — the
  // readiness bar reports that rather than throwing on a body that isn't there.
  const rest = text.slice(end + 1);
  const nl = rest.indexOf("\n");
  const body = nl === -1 ? "" : rest.slice(nl + 1);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].split("#")[0].trim().replace(/^"(.*)"$/, "$1") : undefined;
  };
  return { id: get("id"), title: get("title"), status: get("status"), priority: get("priority"),
           owner: get("owner"), started: get("started"), branch: get("branch"), pr: get("pr"),
           blocked_reason: get("blocked_reason"), touches: get("touches"),
           touchesList: parseListField(head, "touches"),
           servesList: parseListField(head, "serves"), body };
}

export function runDoctor({ flowDir, canonicalVersion, gitStatus }) {
  const problems = [], warnings = [], notes = [];
  const repoRoot = dirname(flowDir);
  const tasksDir = join(flowDir, "tasks");
  const seen = new Map();
  const tasks = [];
  const onDiskTaskPaths = [];

  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    onDiskTaskPaths.push(`.flow/tasks/${name}`);
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (!t) { problems.push(`${name}: malformed frontmatter`); continue; }
    const missing = REQUIRED.filter((k) => !t[k]);
    if (missing.length) { problems.push(`${name}: missing required field(s): ${missing.join(", ")}`); continue; }
    if (!STATUSES.has(t.status)) { problems.push(`${name}: illegal status "${t.status}"`); continue; }
    if (seen.has(t.id)) problems.push(`${name}: duplicate id ${t.id} (also in ${seen.get(t.id)})`);
    seen.set(t.id, name);

    if (t.status === "in_review" && (!t.pr || !t.branch))
      problems.push(`${t.id}: in_review but ${!t.pr ? "pr" : "branch"} is empty — hand-off incomplete or flow-status didn't fire`);
    if (t.status === "blocked" && !t.blocked_reason)
      problems.push(`${t.id}: blocked with no blocked_reason — undecidable AND unexplained`);
    if (t.status === "in_progress" && (!t.owner || !t.started))
      problems.push(`${t.id}: in_progress but ${!t.owner ? "owner" : "started"} is empty — claim was not completed properly`);
    if (t.status === "ready" && t.owner)
      warnings.push(`${t.id}: ready but owner="${t.owner}" — stale claim? clear it so the task is re-claimable`);
    if (t.status === "ready" && (!t.touchesList || t.touchesList.length === 0))
      warnings.push(`${t.id}: ready with empty touches — overlap detection can't protect it under parallel sessions`);

    // Readiness bar: `ready` only, so the bar applies where it belongs — the moment a task is
    // offered to a worker — and never retroactively fails history mid-flight.
    if (t.status === "ready") for (const f of readinessFindings(t)) problems.push(f);

    // New-subsystem tell: every status, because the signal is about the shape of the work and
    // not about when it was written. A warning either way, so a legitimate greenfield task
    // reports and ships.
    for (const { root, glob } of newSubsystemRoots(t.touchesList, repoRoot)) {
      warnings.push(`${t.id}: touches "${glob}" but "${root}/" does not exist in this repo — ` +
        "a task that stands up a whole new subsystem is usually more than one task; " +
        "split it into outcomes that can each merge alone, or confirm the greenfield is intended");
    }
    tasks.push(t);
  }

  // Touches overlap among the *live* set (ready + in_progress). The concurrency model assumes a
  // ready task can be claimed without colliding with anything in flight, and that tasks the
  // orchestrator calls "parallel-safe" truly are. This makes that mechanical, not a prose claim:
  //   - two in_progress tasks sharing touches -> PROBLEM (two sessions in the same files; the
  //     atomic-claim rule was bypassed).
  //   - any other live pair sharing touches   -> WARNING (they can't run in parallel; the queue
  //     will serialize them — surfaced so "parallel-safe" can't be asserted falsely, the exact
  //     miss that shipped two overlapping "parallel" tasks once).
  const live = tasks.filter((t) => t.status === "ready" || t.status === "in_progress");
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const ov = touchesOverlap(live[a].touchesList || [], live[b].touchesList || []);
      if (!ov) continue;
      const where = ov[0] === ov[1] ? ov[0] : `${ov[0]} vs ${ov[1]}`;
      if (live[a].status === "in_progress" && live[b].status === "in_progress")
        problems.push(`${live[a].id} and ${live[b].id} are BOTH in_progress with overlapping touches (${where}) — two sessions in the same files; the atomic-claim rule was bypassed`);
      else
        warnings.push(`${live[a].id} and ${live[b].id} have overlapping touches (${where}) — they can't run in parallel; sequence them or split the shared path (don't label them parallel-safe)`);
    }
  }

  // Board snapshot drift (warn only — live mode and regeneration both fix it).
  const boardPath = join(flowDir, "board.html");
  if (existsSync(boardPath)) {
    const m = readFileSync(boardPath, "utf8").match(/const TASKS = \[([\s\S]*?)\n\];/);
    if (m) {
      const snapIds = new Map([...m[1].matchAll(/id:"([^"]+)"[^}]*?status:"([^"]+)"/g)].map((x) => [x[1], x[2]]));
      for (const t of tasks) {
        if (!snapIds.has(t.id)) warnings.push(`board snapshot missing ${t.id} — regenerate (board-builder)`);
        else if (snapIds.get(t.id) !== t.status)
          warnings.push(`board snapshot has ${t.id}=${snapIds.get(t.id)}, files say ${t.status} — regenerate`);
      }
      for (const id of snapIds.keys())
        if (!seen.has(id)) warnings.push(`board snapshot has ${id} but no task file exists — regenerate`);
    }
  }

  // Gate-coverage floor: every source tree must be declared + mapped to a check, and no
  // undeclared top-level source tree may exist. Graceful adoption: a repo that hasn't declared
  // source_roots yet only gets a warning (so dropping this check into an existing project
  // doesn't fail its gate before it's calibrated).
  const { exists: configExists, declared, roots } = parseSourceRoots(join(flowDir, "config.yml"));
  if (configExists && !declared) {
    warnings.push("no source_roots declared in config.yml — gate coverage is unverified; " +
      "declare each source tree + the check that parses it (see config.yml note).");
  } else if (declared) {
    for (const r of roots) {
      if (!r.path) { problems.push("source_root with no path in config.yml"); continue; }
      if (isPlaceholder(r.path) || isPlaceholder(r.check)) {
        warnings.push(`source_root "${r.path}" is uncalibrated — it still holds the shipped ` +
          `"${PLACEHOLDER}" placeholder; calibrate it (INIT.md step 2, or \`flow-init\`) before ` +
          "relying on the gate-coverage floor.");
        continue;
      }
      if (!r.check) problems.push(`source_root "${r.path}" has no check — declare the command that parses/lints it`);
      if (!existsSync(join(repoRoot, r.path))) problems.push(`source_root "${r.path}" does not exist on disk — stale declaration`);
    }
    for (const dir of topLevelSourceDirs(repoRoot)) {
      if (!roots.some((r) => r.path && !isPlaceholder(r.path) && rootCovers(r.path, dir))) {
        problems.push(`source tree "${dir}/" is not covered by any source_root — declare it (with a check) ` +
          `or it's never parsed before production. If it shouldn't be gated, add it to ROOT_IGNORE.`);
      }
    }
  }

  // Vision-serves: a ready task must name the goal it advances, and that goal must exist.
  // Graceful adoption in both directions — no VISION.md is one warning and nothing else, and a
  // task that is no longer `ready` gets warnings where a ready one gets problems, so adopting
  // the check can't retroactively fail history (flow-doctor fails store-wide, not per-PR: one
  // unanchored task would otherwise redden every open PR in the repo, including PRs whose
  // authors can't fix it, because the store is main-only).
  const visionPath = join(repoRoot, "VISION.md");
  if (!existsSync(visionPath)) {
    warnings.push("no VISION.md at the repo root — the vision layer is inactive and `serves` is unchecked; " +
      "write one (vision-writer skill) so tasks can be anchored to declared goals");
  } else {
    const { goals, malformed } = parseVisionGoals(readFileSync(visionPath, "utf8"));
    for (const line of malformed) {
      warnings.push(`VISION.md: heading "${line}" declares no readable goal id — ` +
        'expected "### G<n> — <title>" (em dash, en dash or hyphen); as written, nothing can resolve against it');
    }
    if (![...goals.values()].some((g) => g.kind === "goal")) {
      // Vacuous-check guard: zero extractable goals means every `serves` below would "fail"
      // for the same reason, so report the format once and skip the per-task pass entirely.
      problems.push("VISION.md declares no goals — expected headings of the form " +
        '"### G<n> — <title>" (and "### NG<n> — <title>" for non-goals). Until one parses, ' +
        "every serves check is vacuous, which is worse than no check at all.");
    } else {
      for (const t of tasks) {
        const ready = t.status === "ready";
        const entries = (t.servesList ?? []).map((e) => e.trim()).filter(Boolean);
        if (entries.length === 0) {
          if (ready)
            problems.push(`${t.id}: ready with no serves — name the VISION.md goal id this advances ` +
              `(or "${MAINTENANCE_SERVES}"); a task nobody can trace to a goal is not ready`);
          continue;
        }
        for (const entry of entries) {
          if (entry.toLowerCase() === MAINTENANCE_SERVES) continue;   // reserved: always resolves, never declared
          const goal = goals.get(entry.toUpperCase());
          if (!goal) {
            (ready ? problems : warnings).push(`${t.id}: serves "${entry}", which VISION.md does not declare — ` +
              "goal ids are append-only and never renumbered, so this resolves to nothing");
          } else if (goal.kind === "non-goal") {
            (ready ? problems : warnings).push(`${t.id}: serves "${entry}", which VISION.md declares a NON-GOAL — ` +
              "that is drift with a paper trail; either the task is wrong or the vision has moved (branch + PR)");
          } else if (goal.retired) {
            warnings.push(`${t.id}: serves "${entry}", a goal under VISION.md's ## Retired — ` +
              "re-anchor it to a live goal, or drop the task with the goal it served");
          }
        }
      }
    }
  }

  // Version drift: Flow infra is authored in canonical and repos adopt it, so a repo can fall
  // behind. When the caller supplies canonical's current version (CI passes FLOW_CANONICAL_VERSION,
  // e.g. from `git ls-remote --tags`), compare it to this repo's `.flow/VERSION` stamp. Warn (don't
  // fail) — same graceful-adoption posture as source_roots: surface the drift, don't block on it.
  // Inactive when no canonical version is supplied, so local runs behave exactly as before.
  if (canonicalVersion !== undefined && canonicalVersion !== "") {
    const versionPath = join(flowDir, "VERSION");
    if (!existsSync(versionPath)) {
      warnings.push(`canonical Flow is ${canonicalVersion} but this repo has no .flow/VERSION stamp — ` +
        "record the adopted version so drift can be detected (see docs/flow-reusable-workflows.md).");
    } else {
      const local = readFileSync(versionPath, "utf8").trim();
      if (compareVersions(local, canonicalVersion) < 0)
        warnings.push(`Flow infra is behind canonical: repo .flow/VERSION=${local}, canonical=${canonicalVersion} — ` +
          "re-sync (bump the reusable-workflow tag + adopt template changes; see docs/flow-reusable-workflows.md).");
    }
  }

  // Uncommitted-task guard (CAN-41): a task isn't in the store until it's committed to main.
  // Fails on task files present on disk but not committed. The git read is injectable
  // (`gitStatus`) for tests; in production it shells out, and skips gracefully (a note) when
  // not in a git work tree — so unit fixtures and tarball checkouts are unaffected.
  const { inRepo, porcelain } = (gitStatus ?? (() => realGitPorcelain(flowDir)))();
  if (inRepo) {
    for (const f of findUncommittedTasks(porcelain, onDiskTaskPaths)) {
      problems.push(
        `${f}: present on disk but not committed — a task isn't in the store until it's committed to main (commit + push it)`,
      );
    }
  } else {
    notes.push("uncommitted-task check skipped — not a git work tree");
  }

  return { problems, warnings, notes, count: tasks.length };
}

// ── CLI ──
if (__isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const canonicalVersion = process.env.FLOW_CANONICAL_VERSION || undefined;
  const { problems, warnings, notes, count } = runDoctor({ flowDir, canonicalVersion });
  console.log(`flow-doctor: ${count} task(s) checked`);
  for (const n of notes ?? []) console.log(`  note  ${n}`);
  for (const w of warnings) console.warn(`  WARN  ${w}`);
  for (const p of problems) console.error(`  FAIL  ${p}`);
  if (!problems.length && !warnings.length) console.log("  store is healthy");
  process.exit(problems.length ? 1 : 0);
}
