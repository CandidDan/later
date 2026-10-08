#!/usr/bin/env node
// flow-doctor.mjs — drift detection for the work store, back-ported from the canary repo's
// `state:check` pattern: a validated store beats a trusted one. Checks that the task
// files are internally consistent and that the board snapshot hasn't drifted from them.
// Run on demand or in CI (flow-tooling job). Exits non-zero on PROBLEMS; WARNINGS report only.
//
//   node .flow/bin/flow-doctor.mjs
//
// PROBLEMS (exit 1): malformed frontmatter · missing required fields · illegal status ·
//   duplicate ids (one message per id, naming EVERY colliding path) · a frontmatter `id:` that
//   disagrees with the id in its own filename · in_review without pr/branch · blocked without blocked_reason ·
//   a populated `blocked_by` on a live non-blocked task, or a malformed `blocked_by` entry ·
//   in_progress without owner/started · two in_progress tasks with overlapping touches (the
//   atomic-claim rule was bypassed) · a declared, CALIBRATED source_root that's missing/uncovered,
//   or a top-level source tree no calibrated source_root covers (the gate-coverage floor — see
//   below) · a task file present on disk but not committed (the uncommitted-task guard — see
//   below) · a ready task whose body doesn't meet the readiness bar, or whose `serves` doesn't
//   resolve against VISION.md (see below) · an intent file with malformed frontmatter, a missing
//   required field, or a duplicate id (see "intent store" below) · a ready task whose `intent`
//   names no intent file (see "tasks derive from intents" below).
// WARNINGS (exit 0): ready task with owner set · blocked task with an empty `blocked_by` (a
//   nudge, never a failure — see below) · ready task with empty touches (concurrency
//   relies on it) · live tasks with overlapping touches (they can't run in parallel — sequence
//   them; don't call them parallel-safe) · board snapshot ids/statuses drifted from the files ·
//   no source_roots declared yet (adoption nudge) · a source_root still holding the shipped
//   REPLACE-ME placeholder in `path` or `check` (uncalibrated, not stale — see below) · Flow
//   infra behind canonical (only when FLOW_CANONICAL_VERSION is set — see "version drift"
//   below) · a task touching a top-level directory that doesn't exist yet (new-subsystem tell) ·
//   no VISION.md (vision layer inactive) · a retired goal, or an unresolvable `serves` on a
//   non-ready task · no `.flow/intents/` (intent layer inactive) · an intent whose `evidence` is
//   declared but isn't a list of paths, whose `status` is outside the three allowed values,
//   whose `serves` names an id VISION.md doesn't declare, or whose `supersedes` names an id no
//   intent declares (all of them warnings — see "intent store" below) · a ready task created
//   on or after `intents.required_from` with no `intent` and a non-maintenance `serves`, a
//   dangling `intent` on a non-ready task, an `intent` naming a superseded intent, or a store
//   with `intents.required_from` unset (see "tasks derive from intents" below).
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
// INTENT STORE (flow-0063). VISION.md's G11 — work traces to a stated intent — needs somewhere
// for intents to live and something that can see them. `.flow/intents/*.md` is the store,
// `_TEMPLATE.md` excluded, and this checks its SHAPE only: frontmatter parses, `id`/`title`/
// `status`/`created`/`source` present, ids unique. `approved_by`/`approved_at` are deliberately
// unvalidated (CI stamps them from the merge — ADR-0007) and a malformed `evidence` is a warning,
// so adopting the layer cannot turn a repo red. No `.flow/intents/` → one warning, same graceful
// posture as a missing VISION.md. The reasoning, and what was deliberately left unchecked, is in
// `docs/adr/0007-intent-layer.md`.
//
// GATE-COVERAGE FLOOR. config.yml declares `source_roots:` — each `{ path, check }` naming a
// tree and the command that parses/lints it. The gate only validates trees a command reaches,
// so an undeclared runtime is invisible until production (real incident: Deno edge functions,
// gate ran only in app/, a parse error took down inbound for ~7 days). This check makes the
// floor a *declared, ratcheting* contract and catches it drifting as the repo grows: a new
// top-level source tree that no calibrated `source_root` covers FAILS the gate until it's
// declared (or explicitly ignored — `source_roots_ignore:` in config.yml, flow-0102, which is how
// a repo extends the ignore set without patching this file). It can't prove a command truly
// parses a tree — it makes coverage explicit and reviewed, not magically complete.
//
// UNCALIBRATED VS STALE (flow-0017). A fresh scaffold still holds the shipped `REPLACE-ME`
// sentinel in `path` and/or `check` — that is "hasn't been calibrated yet", not "drifted", and
// collapsing the two into one PROBLEM makes the first thing an adopter sees after scaffolding a
// red doctor blaming them for drift they haven't had the chance to create. So a `source_root`
// whose `path` or `check` is still `REPLACE-ME` is a WARNING naming the entry, not a PROBLEM, and
// is excluded from the missing-check / stale-path checks and from covering the backstop scan
// below (an uncalibrated entry proves nothing, so it must not appear to satisfy coverage). A
// non-placeholder `path` absent from disk is still stale drift and still a PROBLEM.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { STATUSES } from "./apply-board-edits.mjs";
import { parseAsks } from "./asks.mjs";


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

// ── source_roots_ignore (flow-0102) ──
// ROOT_IGNORE above is CANONICAL's list, and it is the whole escape hatch from the
// undeclared-tree FAIL below. A repo whose top-level `docs/` or `holding/` holds source-extension
// files but deliberately isn't gated therefore had no move that the protocol allows: declaring it
// as a `source_root` invents a check for a tree nobody wanted checked, and the only alternative
// was editing this file — a local patch to Flow's own code, which the next `flow-sync` overwrites.
// `source_roots_ignore:` in `.flow/config.yml` is the repo's half of the set: each entry is
// treated exactly as a ROOT_IGNORE entry, everywhere this file consults it.
//
// BARE TOP-LEVEL FOLDER NAMES ONLY — no `/`, no globs — because that is what ROOT_IGNORE holds,
// and a set matched by `.has(name)` cannot honour a pattern. A malformed entry, or one naming a
// folder that isn't there, is a WARNING naming the entry and exempts NOTHING: silently accepting
// `holding/` or `hold*` would leave a repo believing a tree is exempt while the gate still fails
// on it, and silently dropping it would leave a typo undiagnosed. It is never fatal — an
// unreadable escape hatch must not be able to fail a gate all by itself.
const IGNORE_GLOB_CHARS = /[*?[\]{}!]/;

// Strip a trailing `# comment`, whitespace and one layer of quotes from one scalar entry.
function unquoteEntry(v) {
  return v.split("#")[0].trim().replace(/^["'](.*)["']$/, "$1");
}

/**
 * The raw `source_roots_ignore:` entries from config.yml, exactly as written — unvalidated, so
 * the caller can report what the author typed. Both YAML list forms, like `touches:` in a task:
 *   source_roots_ignore: ["docs", "holding"]
 *   source_roots_ignore:
 *     - "docs"
 *
 * Line-scanned rather than YAML-parsed, for the reason `source-roots.mjs` gives: these helpers
 * run in gate jobs with no install step, so `yaml` is not importable. Unquoted inline entries
 * are read too (`[docs, holding]` is valid YAML), because a dropped entry reads as an escape
 * hatch that silently did nothing.
 */
export function parseSourceRootsIgnore(configPath) {
  if (!existsSync(configPath)) return [];
  const lines = readFileSync(configPath, "utf8").split("\n");
  const i = lines.findIndex((l) => /^source_roots_ignore:/.test(l));
  if (i === -1) return [];
  const inline = lines[i].replace(/^source_roots_ignore:\s*/, "").split("#")[0].trim();
  if (inline.startsWith("[")) {
    const body = inline.replace(/^\[/, "").replace(/\]\s*$/, "").trim();
    return body === "" ? [] : body.split(",").map(unquoteEntry);   // `[]` is an empty list, not one empty entry
  }
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\S/.test(lines[j])) break;                 // dedent to the next top-level key → block done
    const t = lines[j].trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = t.match(/^-\s*(.*)$/);
    if (!m) break;
    out.push(unquoteEntry(m[1]));
  }
  return out;
}

/**
 * Validate raw entries against `repoRoot`. Returns `{ ignore, warnings }` — `ignore` holds only
 * the entries that earned their exemption (a bare name that is a real directory), so a warned
 * entry exempts nothing, and `warnings` names every entry that was rejected and why.
 */
export function sourceRootsIgnoreFindings(entries, repoRoot) {
  const ignore = new Set();
  const warnings = [];
  const why = "it exempts nothing, so an undeclared tree is still reported";
  for (const entry of entries) {
    if (entry === "") {
      warnings.push("source_roots_ignore has an empty entry — give it a bare top-level folder " +
        `name, or remove it; ${why}.`);
    } else if (entry.includes("/") || IGNORE_GLOB_CHARS.test(entry)) {
      warnings.push(`source_roots_ignore entry "${entry}" is not a bare top-level folder name — ` +
        `it must hold no "/" and no glob characters (the ignore set is matched by name, ` +
        `not by pattern); ${why}.`);
    } else if (!isDirectory(join(repoRoot, entry))) {
      warnings.push(`source_roots_ignore entry "${entry}" names no folder at the repo root — ` +
        `stale declaration, or a typo; ${why}.`);
    } else {
      ignore.add(entry);
    }
  }
  return { ignore, warnings };
}

// `path` exists AND is a directory. A file named `docs` is not a folder to ignore, and a broken
// symlink must read as absent rather than throw.
function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".rb", ".java", ".kt",
  ".cs", ".php", ".ex", ".exs", ".swift", ".scala", ".dart",
]);

// The `source_roots:` parser and the REPLACE-ME sentinel used to live here, privately. They now
// live in `source-roots.mjs` (flow-0077), because the gate matrix reads the same block and two
// parsers of one block drift — with the drifted copy being whichever one nobody is testing. The
// rules this file applies to what the parser returns are unaltered.
//
// WHY THE IMPORT IS OPTIONAL rather than a plain static `import`. `.flow/bin` is copied into a
// consuming repo by `flow-sync`, and the partial-sync state — flow-doctor.mjs present,
// source-roots.mjs not yet — is real enough that `_flow-gates.yml` has a step whose whole job is
// to name it. A static import turns that state into `ERR_MODULE_NOT_FOUND` before flow-doctor
// checks anything, so a repo mid-sync would lose the store validation too, with a stack trace in
// place of a diagnosis. Loaded this way it is one NOTE and every other check still runs — the
// same posture flow-doctor already takes for a check whose precondition is not met. There is
// still exactly one parser: absent the module there is no fallback scan, only a skip.
const sourceRootsMod = await import("./source-roots.mjs").then((m) => m, () => null);

// Does any directory at or beneath `dir` (bounded depth, ignoring junk) hold a source file?
// `ignore` is ROOT_IGNORE plus the repo's `source_roots_ignore` entries — the same set, at every
// depth, because an entry is "treated exactly as a ROOT_IGNORE entry" and ROOT_IGNORE applies at
// every depth. So a repo ignoring `docs` also stops a nested `src/docs` from making `src/` look
// like a source tree, which is the behaviour it asked for.
function containsSource(dir, depth = 0, ignore = ROOT_IGNORE) {
  if (depth > 4) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith(".")) {
      if (containsSource(join(dir, e.name), depth + 1, ignore)) return true;
    }
  }
  return false;
}

// Top-level dirs (depth 1 from repo root) that hold source and aren't ignored.
function topLevelSourceDirs(repoRoot, ignore = ROOT_IGNORE) {
  let entries;
  try { entries = readdirSync(repoRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => containsSource(join(repoRoot, name), 0, ignore));
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
// Exported for pick-task.mjs (flow-0111): one list parser for the whole store, not three.
// A YAML scalar as written on one line: strip a trailing `# comment` ONLY outside quotes (YAML
// needs whitespace before the `#`), then drop the surrounding quotes. Splitting on the first `#`
// truncated any quoted value carrying a PR or issue reference ("see PR #127") — flow-0119's review.
export function stripYamlComment(s) {
  let q = null;
  // A quote opens a quoted scalar only where a scalar can START: at the beginning of the value
  // or of an inline-list item (after `[` or `,`), with only whitespace between. An apostrophe in
  // the middle of a plain value ("it's simpler") is just a character, as it is in YAML.
  let atScalarStart = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') { i++; continue; }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; } // '' is an escaped quote
        q = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && atScalarStart) { q = c; atScalarStart = false; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    if (c === "[" || c === ",") { atScalarStart = true; continue; }
    if (!/\s/.test(c)) atScalarStart = false;
  }
  return s;
}

export function yamlScalar(raw) {
  const v = stripYamlComment(raw).trim();
  const dq = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (dq) return dq[1].replace(/\\(["\\])/g, "$1");
  const sq = v.match(/^'((?:[^']|'')*)'$/);
  if (sq) return sq[1].replace(/''/g, "'");
  return v;
}

const QUOTED_ITEM = /"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'/g;

export function parseListField(head, key) {
  const lines = head.split("\n");
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (i === -1) return [];
  const inline = stripYamlComment(lines[i].replace(new RegExp(`^\\s*${key}:\\s*`), "")).trim();
  if (inline.startsWith("[")) {
    return [...inline.matchAll(QUOTED_ITEM)]
      .map((m) => (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2].replace(/''/g, "'")))
      .filter(Boolean);
  }
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = t.match(/^-\s*(.+)$/);
    if (!m) break; // dedent to the next key → list done
    out.push(yamlScalar(m[1]));
  }
  return out.filter(Boolean);
}

// ── blocked_by (flow-0040) ──
// `blocked` is the only status with no automated way out: `flow-status` owns `in_review`,
// `flow-done` owns `done`, `flow-recover` heals a stranded `in_progress`, and a blocked task
// sits there until a human notices the thing it waited on has landed. Almost every real block
// is a dependency the machine can already see — a PR merging, another task reaching `done` —
// but it was recorded only in `blocked_reason`, which is prose written for a person. `blocked_by`
// is the machine-readable half of that sentence: a list, each entry a task id in this repo or a
// PR url. It never replaces `blocked_reason`; a person still needs the sentence.
//
// An entry is a task id (`<slug>-<digits>`, the shape `_TEMPLATE.md` mandates) or an http(s)
// url. Nothing here checks that a referenced id EXISTS in the store — a dangling reference is a
// real defect, but resolving it is the job of the sweep that consumes this field, and a store
// validator that guesses at cross-repo ids would fail closed on data it can't see.
const TASK_ID_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const BLOCKED_BY_URL_RE = /^https?:\/\/\S+$/;
export function isBlockedByEntry(entry) {
  const v = String(entry ?? "").trim();
  return TASK_ID_RE.test(v) || BLOCKED_BY_URL_RE.test(v);
}

// The documented opt-out for a block that genuinely isn't mechanical (waiting on a phone call,
// a legal sign-off, a human decision). A SENTINEL, not prose parsing: the words are fixed and
// documented in `_TEMPLATE.md` and `PROTOCOL.md`, and they read as part of an ordinary English
// sentence, so the escape hatch costs a writer nothing and still has an exact shape. The whole
// point of this field is that `blocked_reason`'s shape is not a contract — so the check reads
// one literal token out of it and nothing else.
const NOT_MACHINE_CHECKABLE = /not machine-checkable/i;
export function blockedByFindings(task) {
  const problems = [], warnings = [];
  const id = task.id;
  const entries = (task.blockedByList ?? []).map((e) => String(e).trim()).filter(Boolean);

  // WARNING, deliberately — and the only one of these three a store written before this field
  // can trip. Criterion 6 of flow-0040: adopting the field must not turn an already-adopted
  // repo red, and every blocked task in every such repo predates it. A nudge that names the fix
  // is the most this can be without punishing people for history.
  if (task.status === "blocked" && entries.length === 0 && !NOT_MACHINE_CHECKABLE.test(task.blocked_reason ?? ""))
    warnings.push(`${id}: blocked with an empty blocked_by — nothing but a human can tell when this clears; ` +
      "list the task id or PR url it waits on in `blocked_by`, or write \"not machine-checkable\" " +
      "in `blocked_reason` to say the block genuinely isn't mechanical");

  // PROBLEM. Unreachable for a store written before this field (absent is not populated), so it
  // cannot redden an existing repo, and a dependency that outlived its block is data that lies:
  // it says "waiting on X" about a task nobody is waiting on. `done` is exempt — there the field
  // is the historical record of what the task waited on, and clearing it would destroy that.
  if (entries.length && task.status !== "blocked" && task.status !== "done")
    problems.push(`${id}: ${task.status} but blocked_by is populated (${entries.join(", ")}) — ` +
      "a dependency that outlived its block is stale data; clear blocked_by when the block clears");

  // PROBLEM, for the same reason: only data written after this change can be malformed. An
  // entry nothing can parse is this field failing at the one job it has.
  for (const entry of entries)
    if (!isBlockedByEntry(entry))
      problems.push(`${id}: blocked_by entry "${entry}" is malformed — ` +
        "each entry must be a task id (PROJ-0007) or a PR url (https://…)");

  return { problems, warnings };
}

// ── asks (flow-0119) ──
// `notes` is the handoff to the next SESSION; `asks` is the queue for the HUMAN. The split only
// means anything if the shape is enforced, because the consumers (the PR comment, inflight) route
// on the kind and would silently drop an entry they could not read — reproducing the bug `asks`
// was written to fix, one layer further down where nobody is looking for it.
//
// Every finding here is a PROBLEM, not a warning, and that is a deliberate departure from
// `blocked_by`'s graceful-adoption posture above. `blocked_by` could trip on history: every
// blocked task in every already-adopted repo predates the field. `asks` cannot — a task with no
// `asks:` key parses as an empty list and raises nothing, so the only way to be malformed here is
// to have been written after this change. There is no history to punish.
export function asksFindings(task) {
  const { errors } = parseAsks(task.asksList ?? []);
  return { problems: errors.map((e) => `${task.id}: ${e}`), warnings: [] };
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
function newSubsystemRoots(touchesList, repoRoot, ignore = ROOT_IGNORE) {
  const out = [];
  for (const glob of touchesList ?? []) {
    if (!glob.includes("/")) continue;                       // a bare file at the repo root
    const root = staticPrefix(glob).split("/")[0];
    if (!root || ignore.has(root)) continue;
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

// ── intent store (flow-0063) ──
// VISION.md's G11 says work traces to a stated intent: something a human asked for, written down
// before it was scoped. `.flow/intents/` is where those live. The store sits on the CODE plane,
// not the task plane — `plane-guard`'s STORE_PREFIX is `.flow/tasks/`, deliberately not `.flow/`
// — so an intent arrives by branch and PR, which is what lets the merge itself BE the approval
// event rather than a field somebody typed.
//
// THIS CHECK HAS NO TEETH BEYOND SHAPE, and that is ADR-0004's teeth budget being spent
// deliberately rather than forgotten. Whether an intent is a *good* intent is judgment, so
// nothing here reads a word of the prose. What it checks is mechanical and unarguable: the
// frontmatter parses, the required fields are present, and no two intents claim one id.
//
//   · `approved_by` / `approved_at` are UNVALIDATED. CI stamps them from the merge (ADR-0007,
//     slice 4). A checker that demanded them today would fail every intent that is still waiting
//     to be approved — which is every intent, at the one moment anyone looks at it.
//   · `evidence` is an append-only list of repo paths to evidence records written after the work
//     ships. Malformed → WARNING, never a PROBLEM: the same budget applies, and nothing in this
//     slice reads the value.
//   · No `.flow/intents/` at all → exactly one warning and nothing else, matching the posture
//     flow-doctor already takes toward a missing VISION.md, so an adopting repo stays green.
//   · `_TEMPLATE.md` is excluded, exactly as it is in `.flow/tasks/` — the published shape is
//     not an instance of itself, and validating it would fail every repo on the empty fields it
//     ships on purpose.
//
// WHAT flow-0073 ADDED, AND WHY EVERY ONE OF IT IS A WARNING. The template grew `serves`,
// `supersedes`, a stated `status` vocabulary and the `[assumption]` marker, so the checker has
// three more mechanical questions it can answer. It is still slice 1, so it still spends no
// teeth: the whole intent layer is warn-only until slice 2, when tasks start depending on
// intents and a dangling reference stops being cosmetic.
//
//   · `serves` resolves against VISION.md exactly as a task's does, reserved `maintenance`
//     included — same ids, one store of goals. Unresolvable → WARNING (a ready task gets a
//     PROBLEM for the same thing; an intent is not a unit of work and nothing is scheduled off
//     it yet). No VISION.md, or a VISION.md nothing parses out of, and the check is INACTIVE:
//     not one per-intent line, because the repo-level warning already said the layer is off and
//     repeating it per file is how an adoption nudge turns into noise.
//     A `serves` naming a NON-GOAL or a RETIRED goal is deliberately not reported here. Both are
//     declared ids, so they are not the "does not declare" case, and the task-side warnings that
//     do cover them exist to prompt a re-anchor or a drop — neither of which is a move anyone
//     can make on an intent, whose body is never revised.
//   · `status` outside `proposed | approved | superseded` → WARNING naming the value. Presence is
//     still a PROBLEM (it is in INTENT_REQUIRED); this is only about the vocabulary. Nothing acts
//     on the value yet, so a typo must not redden the gate — but a typo that nothing ever
//     mentions is how `aproved` ends up in the store for a year.
//   · `supersedes` naming an id no intent in the store declares → WARNING naming both. This is
//     the one rule that reads across files rather than within one, so ids are collected from
//     every intent before any of them is checked.
//   · `[assumption]` lines are NEVER reported, at any status, and there is deliberately no code
//     below that looks for one. An intent can be approved with assumptions still standing in it
//     — that is what marking them is for. A checker that nagged about them would teach authors
//     to stop marking, which costs the marker its entire value.
export const INTENT_REQUIRED = ["id", "title", "status", "created", "source"];

// The `status` vocabulary, in the order the template lists it. Exported so the template's own
// guidance can be asserted against the checker's set rather than against a second hand-typed
// copy of it.
export const INTENT_STATUSES = ["proposed", "approved", "superseded"];

// A YAML scalar that is not a string, written bare. `evidence` holds repo paths, so these are the
// values that mean someone typed the wrong kind of thing rather than a path.
const NON_STRING_SCALAR = /^(-?\d+(?:\.\d+)?|true|false|null|~)$/i;

// Is one frontmatter list entry a plain string? Rejects a flow collection (`[…]`, `{…}`), a
// mapping (`path: x`), an empty entry, and a bare non-string scalar. Quotes are stripped first,
// so `"3"` is a string and `3` is not.
function isScalarStringEntry(raw) {
  const v = String(raw).trim();
  if (v === "") return false;
  const quoted = v.match(/^"([^"]*)"$/) ?? v.match(/^'([^']*)'$/);
  if (quoted) return quoted[1] !== "";
  return !/^[[{]/.test(v) && !/:(\s|$)/.test(v) && !NON_STRING_SCALAR.test(v);
}

// Classify `evidence:` without a YAML dependency (nothing under this tree may take one — it is
// copied into repos that are not JavaScript projects). Three verdicts:
//   "absent"      the key is not declared at all
//   "list"        an empty list, or a list whose every entry is a string — inline or block form
//   "not-a-list"  anything else
// Absent and empty collapse to "nothing to report" at the call site on purpose: the template
// ships `evidence: []`, an intent written before the field existed has neither, and both are
// the same fact — no evidence has been gathered yet.
export function evidenceShape(head) {
  const lines = String(head).split("\n");
  const i = lines.findIndex((l) => /^\s*evidence:/.test(l));
  if (i === -1) return "absent";
  const inline = lines[i].replace(/^\s*evidence:\s*/, "").split("#")[0].trim();
  if (inline.startsWith("[")) {
    if (!inline.endsWith("]")) return "not-a-list";
    const inner = inline.slice(1, -1).trim();
    return inner === "" || inner.split(",").every(isScalarStringEntry) ? "list" : "not-a-list";
  }
  if (inline !== "") return "not-a-list";              // a scalar: `evidence: "docs/x.md"`
  const entries = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = t.match(/^-\s*(.*)$/);
    if (!m) break;                                     // dedent to the next key → list done
    entries.push(m[1].split("#")[0]);
  }
  // `evidence:` with nothing beneath it is YAML null, which is the empty case, not a broken one.
  return entries.length === 0 || entries.every(isScalarStringEntry) ? "list" : "not-a-list";
}

function parseIntent(text) {
  const fm = splitFrontmatter(text);
  if (!fm) return null;
  const get = scalarReader(fm.head);
  const out = {
    evidence: evidenceShape(fm.head),
    supersedes: get("supersedes"),
    servesList: parseListField(fm.head, "serves"),
  };
  for (const k of INTENT_REQUIRED) out[k] = get(k);
  return out;
}

// Validate `<flowDir>/intents/`. Exported so the shape contract can be asserted directly, and
// because a consuming repo's own tests are the only place some of this is reachable.
//
// `goals` is the VISION.md goal map (`parseVisionGoals().goals`) when the vision layer is active
// and usable, and null otherwise — no VISION.md, or one nothing parses out of. Null switches the
// `serves` check OFF rather than failing every entry: the caller has already emitted exactly one
// repo-level finding about the vision layer, and restating it per intent would bury it.
export function intentFindings(intentsDir, { goals = null } = {}) {
  const problems = [], warnings = [];
  if (!existsSync(intentsDir)) {
    warnings.push("no .flow/intents/ — the intent layer is inactive, so nothing records who asked " +
      "for the work or why (VISION.md G11); create the store and write intents with the " +
      "intent-writer skill");
    return { problems, warnings, count: 0, intents: null };
  }
  // Read every intent before checking any of them: `supersedes` resolves against the ids the
  // whole store declares, so a forward reference to an intent later in the sort order must not
  // read as dangling.
  const parsed = [];
  for (const name of readdirSync(intentsDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const rel = `.flow/intents/${name}`;
    const intent = parseIntent(readFileSync(join(intentsDir, name), "utf8"));
    if (!intent) { problems.push(`${rel}: malformed frontmatter`); continue; }
    parsed.push({ rel, intent });
  }
  const declared = new Set(parsed.map(({ intent }) => intent.id).filter(Boolean));
  const seen = new Map();
  for (const { rel, intent } of parsed) {
    const missing = INTENT_REQUIRED.filter((k) => !intent[k]);
    if (missing.length) problems.push(`${rel}: missing required field(s): ${missing.join(", ")}`);
    if (intent.id) {
      const first = seen.get(intent.id);
      if (first) problems.push(`duplicate intent id ${intent.id} — declared in both ${first} and ${rel}`);
      else seen.set(intent.id, rel);
    }
    if (intent.evidence === "not-a-list") {
      warnings.push(`${rel}: evidence is declared but is not a list of paths — it is an append-only ` +
        "list of repo paths to evidence records, so a scalar or a mapping there will not be read; " +
        "a warning, not a failure, while nothing consumes it");
    }
    // Vocabulary only — an absent `status` is already a PROBLEM above, and this says nothing
    // about whether the value is the RIGHT one, which is the merge event's business (slice 4).
    if (intent.status && !INTENT_STATUSES.includes(intent.status)) {
      warnings.push(`${rel}: status "${intent.status}" is not one of ` +
        `${INTENT_STATUSES.join(" | ")} — nothing reads the value yet, so this is a warning, but ` +
        "a status outside the vocabulary will not be read when something does");
    }
    const supersedes = (intent.supersedes ?? "").trim();
    if (supersedes && !declared.has(supersedes)) {
      warnings.push(`${rel}: supersedes "${supersedes}", which no intent in .flow/intents/ declares — ` +
        "a replacement has to name the intent it replaces by its id, or the record of the changed " +
        "mind points at nothing");
    }
    if (goals) {
      for (const raw of intent.servesList ?? []) {
        const entry = raw.trim();
        if (!entry || entry.toLowerCase() === MAINTENANCE_SERVES) continue;
        if (!goals.has(entry.toUpperCase())) {
          warnings.push(`${rel}: serves "${entry}", which VISION.md does not declare — ` +
            "goal ids are append-only and never renumbered, so this resolves to nothing");
        }
      }
    }
  }
  // id → status for every intent that declares an id, for taskIntentFindings. First declaration
  // wins, matching the duplicate report above — a duplicate is already a PROBLEM in its own right.
  const intents = new Map();
  for (const { intent } of parsed) {
    if (intent.id && !intents.has(intent.id)) intents.set(intent.id, intent.status ?? "");
  }
  return { problems, warnings, count: parsed.length, intents };
}

// ── tasks derive from intents (flow-0074, ADR-0007 slice 2) ─────────────────────────────────
// A task names the intent it came from in `intent:`. This is the slice that moves the human's
// first touchpoint from approving a task spec to approving an intent, so it is rolled out the
// way `serves` was: WARN-FIRST, with exactly one failure, and that failure a fact check.
//
//   · Empty `intent` on a `ready` task created on or after `intents.required_from`, whose
//     `serves` is not maintenance-only → WARNING. Not a failure in this slice: escalating it is a
//     later task, once intent-derived tasks exist to justify the teeth. `serves` empty counts as
//     not-maintenance — the exemption is for work that SAYS it is maintenance, not for silence.
//   · Non-empty `intent` naming no intent's `id` → PROBLEM on `ready`, WARNING otherwise. A typo or
//     a dangling id is a fact, not a judgment, and no task carried `intent` before this rule
//     existed, so it cannot redden history.
//   · `intent` resolving to `status: superseded` → WARNING naming both.
//   · `proposed` is NOT a finding. Intents reach `main` only by a merged PR and the merge IS the
//     approval (ADR-0007); nothing stamps `approved` until slice 4. Present on main = approved.
//
// FORWARD-ONLY is a date in config, not a hand-kept grandfather list (ADR-0007 rejects lists,
// because they rot): `intents.required_from: "YYYY-MM-DD"`. Each repo sets its own date when it
// adopts intents. Unset with a store present → ONE warning naming the key, and no per-task
// missing-intent warnings. No store at all → nothing here; intentFindings has already said so.
export const INTENTS_REQUIRED_FROM_KEY = "intents.required_from";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `intents.required_from` from config.yml: the string as written (quotes and comment stripped),
 * or undefined when the `intents:` block or the key is absent. Line-scanned, not YAML-parsed —
 * these helpers run in gate jobs with no install step (see parseSourceRootsIgnore).
 *   intents:
 *     required_from: "2026-10-06"
 */
export function parseIntentsRequiredFrom(configPath) {
  if (!existsSync(configPath)) return undefined;
  const lines = readFileSync(configPath, "utf8").split("\n");
  const i = lines.findIndex((l) => /^intents:\s*(#.*)?$/.test(l));
  if (i === -1) return undefined;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\S/.test(lines[j])) break;                 // dedent → the block is over
    const m = lines[j].match(/^\s+required_from:\s*(.*)$/);
    if (m) return unquoteEntry(m[1]);
  }
  return undefined;
}

/**
 * Task → intent findings. `intents` is intentFindings' id → status map, or null when there is no
 * `.flow/intents/` (then nothing is reported). `requiredFrom` is the raw config value.
 */
export function taskIntentFindings(tasks, intents, requiredFrom) {
  const problems = [], warnings = [];
  if (!intents) return { problems, warnings };
  let cutoff = null;
  if (requiredFrom === undefined || requiredFrom === "") {
    warnings.push(`${INTENTS_REQUIRED_FROM_KEY} is not set in .flow/config.yml — the missing-intent ` +
      "rule is inactive, so a ready task that names no intent goes unreported; set it to the date " +
      "this repo adopted intents (YYYY-MM-DD). Tasks created before it are never asked for one.");
  } else if (!ISO_DATE.test(requiredFrom)) {
    warnings.push(`${INTENTS_REQUIRED_FROM_KEY} is "${requiredFrom}", not a YYYY-MM-DD date — the ` +
      "missing-intent rule is inactive until it parses");
  } else {
    cutoff = requiredFrom;
  }
  for (const t of tasks) {
    const intent = (t.intent ?? "").trim();
    const ready = t.status === "ready";
    if (intent) {
      if (!intents.has(intent)) {
        (ready ? problems : warnings).push(`${t.id}: intent "${intent}" names no intent in .flow/intents/ — ` +
          "a task derives from an intent already on main; fix the id, or merge the intent first");
      } else if (intents.get(intent) === "superseded") {
        warnings.push(`${t.id}: intent "${intent}" is superseded — re-derive the task from the intent ` +
          "that replaced it, or drop the task");
      }
      continue;
    }
    if (!ready || !cutoff) continue;
    const created = String(t.created ?? "").slice(0, 10);
    if (!ISO_DATE.test(created) || created < cutoff) continue;
    const serves = (t.servesList ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (serves.length && serves.every((e) => e === MAINTENANCE_SERVES)) continue;
    warnings.push(`${t.id}: ready with no intent — work that serves a product goal starts from an ` +
      `intent already on main (intent-writer skill); name its id in \`intent:\`, or use serves ` +
      `["${MAINTENANCE_SERVES}"] if it is maintenance. A warning in this slice, not yet a failure.`);
  }
  return { problems, warnings };
}

// ── store identity: one id, one file (flow-0052) ──────────────────────────────────────────
// `allocate-task-id.mjs` allocates correctly, but using it is optional: a session that
// hand-writes a task file bypasses it entirely and git raises nothing, because two slugs are
// two paths — `flow-0049-claude-md-ceiling.md` and `flow-0049-queue-runner-*.md` merge cleanly.
// That happened on canonical's `main` on 2026-09-15 and was cleared by a human who happened to
// look. The harm is silent rather than loud: `flightdeck/bin/mission-control.mjs` keys tasks by
// id, so the second file overwrites the first and one task disappears from the state report with
// no error. These two functions are the store-level invariant behind the allocator — they make
// incorrect allocation DETECTABLE; they do not make it impossible, and they deliberately do not
// renumber anything (which file keeps the id is the orchestrator's call, not a guard's).

// The id a task file's NAME declares, or null when the name carries none. The convention is
// `<id>-<slug>.md`, and an id is `PREFIX-1234` (TASK_ID_RE's shape). A file whose name does not
// open with an id — the template's own `0001-newsletter-signup.md`, say — declares nothing for
// the frontmatter to disagree WITH, so it is not a finding. Anchored and lookahead-bounded so
// `flow-0052-x.md`, `flow-0052.md` and `flow-00521-x.md` each yield their own id, never a prefix
// of a longer one.
export function filenameTaskId(name) {
  const m = String(name).match(/^([A-Za-z][A-Za-z0-9_]*-\d+)(?=[-.]|$)/);
  return m ? m[1] : null;
}

// One problem per duplicated id, naming EVERY path that declares it — not a count, and not the
// first colliding pair. The fix is choosing which file gets renumbered, so a message that names
// two of three paths sends whoever reads it back to the store to find the third.
//   entries  `{ path, id }` in store order; entries with no id are ignored.
export function duplicateIdProblems(entries) {
  const byId = new Map();
  for (const { path, id } of entries) {
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(path);
  }
  const problems = [];
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    problems.push(`duplicate id ${id} — declared by ${paths.length} task files: ${paths.join(", ")}. ` +
      "Renumber all but one (allocate-task-id.mjs picks the next free id); until then the id " +
      "resolves to whichever file is read last and the others vanish from every id-keyed view.");
  }
  return problems;
}

// The frontmatter id and the filename id must agree. The 2026-09-15 collision was cleared by a
// rename, and a rename that forgets the frontmatter re-creates the same ambiguity one layer down:
// the store then holds a file findable under one id and self-describing as another.
export function filenameIdProblems(name, id) {
  const fromName = filenameTaskId(name);
  if (!fromName || !id || fromName === id) return [];
  return [`.flow/tasks/${name}: frontmatter id "${id}" disagrees with the id in its own filename ` +
    `("${fromName}") — a rename that forgot the frontmatter, or the reverse. Fix whichever is ` +
    "wrong so the file is findable under the id it declares."];
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

// Split a Markdown file into its frontmatter head and the body after it, or null when there is
// no closing `---` — which is what every caller reports as malformed frontmatter. Shared by the
// task reader and the intent reader so the two stores can never disagree about what "parses"
// means; a file either has frontmatter under both or under neither.
function splitFrontmatter(text) {
  if (!String(text).startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  // Everything after the closing `---` line. "" when the file is frontmatter only — the
  // readiness bar reports that rather than throwing on a body that isn't there.
  const rest = text.slice(end + 1);
  const nl = rest.indexOf("\n");
  return { head: text.slice(3, end), body: nl === -1 ? "" : rest.slice(nl + 1) };
}

// Reader for a scalar frontmatter field: drops a trailing `# comment` and one layer of double
// quotes. Returns undefined when the key is absent, which is how "missing" is distinguished
// from "declared empty" everywhere above.
function scalarReader(head) {
  return (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? yamlScalar(m[1]) : undefined;
  };
}

function parseTask(text) {
  const fm = splitFrontmatter(text);
  if (!fm) return null;
  const { head, body } = fm;
  const get = scalarReader(head);
  return { id: get("id"), title: get("title"), status: get("status"), priority: get("priority"),
           owner: get("owner"), started: get("started"), branch: get("branch"), pr: get("pr"),
           blocked_reason: get("blocked_reason"), touches: get("touches"),
           touchesList: parseListField(head, "touches"),
           blockedByList: parseListField(head, "blocked_by"),
           servesList: parseListField(head, "serves"),
           intent: get("intent"), created: get("created"),
           asksList: parseListField(head, "asks"), body };
}

export function runDoctor({ flowDir, canonicalVersion, gitStatus }) {
  const problems = [], warnings = [], notes = [];
  const repoRoot = dirname(flowDir);
  const tasksDir = join(flowDir, "tasks");
  const configPath = join(flowDir, "config.yml");

  // The repo's own additions to ROOT_IGNORE, resolved BEFORE the task loop: the new-subsystem
  // tell inside that loop consults the same set, so parsing it later would exempt the
  // undeclared-tree scan and silently not the tell.
  const { ignore: extraIgnore, warnings: ignoreWarnings } =
    sourceRootsIgnoreFindings(parseSourceRootsIgnore(configPath), repoRoot);
  warnings.push(...ignoreWarnings);
  const rootIgnore = extraIgnore.size ? new Set([...ROOT_IGNORE, ...extraIgnore]) : ROOT_IGNORE;
  // Every id the store declares, with the path that declared it — gathered for the duplicate
  // scan below. Collected BEFORE the field/status guards below `continue`, on purpose: a
  // collision must not be able to hide behind an unrelated missing field in one of its halves.
  const declaredIds = [];
  const tasks = [];
  const onDiskTaskPaths = [];

  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    onDiskTaskPaths.push(`.flow/tasks/${name}`);
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (!t) { problems.push(`${name}: malformed frontmatter`); continue; }
    if (t.id) declaredIds.push({ path: `.flow/tasks/${name}`, id: t.id });
    problems.push(...filenameIdProblems(name, t.id));
    const missing = REQUIRED.filter((k) => !t[k]);
    if (missing.length) { problems.push(`${name}: missing required field(s): ${missing.join(", ")}`); continue; }
    if (!STATUSES.has(t.status)) { problems.push(`${name}: illegal status "${t.status}"`); continue; }

    if (t.status === "in_review" && (!t.pr || !t.branch))
      problems.push(`${t.id}: in_review but ${!t.pr ? "pr" : "branch"} is empty — hand-off incomplete or flow-status didn't fire`);
    if (t.status === "blocked" && !t.blocked_reason)
      problems.push(`${t.id}: blocked with no blocked_reason — undecidable AND unexplained`);
    {
      const b = blockedByFindings(t);
      problems.push(...b.problems);
      warnings.push(...b.warnings);
    }
    {
      const a = asksFindings(t);
      problems.push(...a.problems);
      warnings.push(...a.warnings);
    }
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
    for (const { root, glob } of newSubsystemRoots(t.touchesList, repoRoot, rootIgnore)) {
      warnings.push(`${t.id}: touches "${glob}" but "${root}/" does not exist in this repo — ` +
        "a task that stands up a whole new subsystem is usually more than one task; " +
        "split it into outcomes that can each merge alone, or confirm the greenfield is intended");
    }
    tasks.push(t);
  }

  // One id, one file. Reported after the loop so every colliding path is named in a single
  // message, rather than a chain of pairwise "also in …" lines that each omit the rest.
  problems.push(...duplicateIdProblems(declaredIds));

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
      const storeIds = new Set(declaredIds.map((e) => e.id));
      for (const id of snapIds.keys())
        if (!storeIds.has(id)) warnings.push(`board snapshot has ${id} but no task file exists — regenerate`);
    }
  }

  // Gate-coverage floor: every source tree must be declared + mapped to a check, and no
  // undeclared top-level source tree may exist. Graceful adoption: a repo that hasn't declared
  // source_roots yet only gets a warning (so dropping this check into an existing project
  // doesn't fail its gate before it's calibrated).
  const { exists: configExists, declared, roots } = sourceRootsMod
    ? sourceRootsMod.parseSourceRoots(configPath)
    : { exists: false, declared: false, roots: [] };
  if (!sourceRootsMod) {
    notes.push("gate-coverage floor skipped — source-roots.mjs is not present beside flow-doctor.mjs; " +
      "run flow-sync to pick up the rest of .flow/bin/");
  } else if (configExists && !declared) {
    warnings.push("no source_roots declared in config.yml — gate coverage is unverified; " +
      "declare each source tree + the check that parses it (see config.yml note).");
  } else if (declared) {
    for (const r of roots) {
      if (!r.path) { problems.push("source_root with no path in config.yml"); continue; }
      if (sourceRootsMod.isPlaceholder(r.path) || sourceRootsMod.isPlaceholder(r.check)) {
        warnings.push(`source_root "${r.path}" is uncalibrated — it still holds the shipped ` +
          `"${sourceRootsMod.PLACEHOLDER}" placeholder; calibrate it (INIT.md step 2, or \`flow-init\`) before ` +
          "relying on the gate-coverage floor.");
        continue;
      }
      if (!r.check) problems.push(`source_root "${r.path}" has no check — declare the command that parses/lints it`);
      if (!existsSync(join(repoRoot, r.path))) problems.push(`source_root "${r.path}" does not exist on disk — stale declaration`);
    }
    for (const dir of topLevelSourceDirs(repoRoot, rootIgnore)) {
      if (!roots.some((r) => r.path && !sourceRootsMod.isPlaceholder(r.path) && rootCovers(r.path, dir))) {
        problems.push(`source tree "${dir}/" is not covered by any source_root — declare it (with a check) ` +
          `or it's never parsed before production. If it shouldn't be gated, list it in ` +
          `source_roots_ignore in .flow/config.yml — ignoring a tree is a decision, not a default.`);
      }
    }
  }

  // Vision-serves: a ready task must name the goal it advances, and that goal must exist.
  // Graceful adoption in both directions — no VISION.md is one warning and nothing else, and a
  // task that is no longer `ready` gets warnings where a ready one gets problems, so adopting
  // the check can't retroactively fail history (flow-doctor fails store-wide, not per-PR: one
  // unanchored task would otherwise redden every open PR in the repo, including PRs whose
  // authors can't fix it, because the store is main-only).
  // Non-null only once the vision layer is both present and usable, which is exactly when a
  // `serves` on an intent can be resolved. Handed to intentFindings below so the two stores read
  // one goal map — a second parse could drift from this one and disagree about the same file.
  let visionGoals = null;
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
      visionGoals = goals;
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
            // `done` is exempt — and ONLY `done`. This warning offers two remedies and a finished
            // task can take neither. It cannot be dropped: the completed record is the point. And
            // it cannot be re-anchored either, not as a matter of taste but by rule — `serves`
            // records the goal a task was WRITTEN to advance, so back-filling a live id onto
            // finished work falsifies the history rather than correcting it (task-writer says the
            // same: don't retrofit `serves` onto in_progress/in_review/done/blocked).
            //
            // `blocked`, `in_progress` and `in_review` keep warning, because each is still live
            // and at least one remedy — dropping it — remains a real call for the reader.
            //
            // Without this, retiring several goals at once buries the signal: canonical retired
            // G1-G5 in a single vision rewrite, and every task predating it warned forever. 28 of
            // the 36 lines named settled history, and the one `ready` task that genuinely needed
            // re-anchoring sat 30th in the list. A check nobody can act on is a check nobody reads.
            if (t.status !== "done") {
              warnings.push(`${t.id}: serves "${entry}", a goal under VISION.md's ## Retired — ` +
                "re-anchor it to a live goal, or drop the task with the goal it served");
            }
          }
        }
      }
    }
  }

  // Intent store: shape only, and an absent store is one warning — see the intent-store block above.
  {
    const f = intentFindings(join(flowDir, "intents"), { goals: visionGoals });
    problems.push(...f.problems);
    warnings.push(...f.warnings);
    const d = taskIntentFindings(tasks, f.intents, parseIntentsRequiredFrom(configPath));
    problems.push(...d.problems);
    warnings.push(...d.warnings);
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
