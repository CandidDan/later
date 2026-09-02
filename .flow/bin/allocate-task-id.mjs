#!/usr/bin/env node
// allocate-task-id.mjs — first-push-wins task-id allocation. Pure core + a git transaction,
// zero dependencies beyond `flow-state.mjs` (Node >= 18).
//
// THE PROBLEM. Claiming a task is safe under concurrency: two workers claiming the same task
// edit the SAME file, so the loser's `git push` to `main` is a non-fast-forward and git refuses
// it. Creating a task is not: two orchestrators both read the store, both compute `flow-0021`
// as the next id, and both write DIFFERENT filenames (`flow-0021-a.md`, `flow-0021-b.md`). Both
// pushes succeed — nothing is refused, nothing is logged — and `flow-doctor` only catches the
// duplicate id afterwards, on `main`, after every open PR has gone red on a defect none of their
// authors can fix from a branch. This happened on 2026-08-19 (flow-0021's task file).
//
// THE FIX. Treat the push itself as the arbiter, the same way the claim already does: read
// `origin/main` fresh, allocate against it, commit, and push. If the push is refused, someone
// else landed first — RE-FETCH and RE-ALLOCATE (never `pull --rebase`, which would silently
// replay the stale id past a git refusal that exists specifically to catch it) and retry, bounded.
//
//   node allocate-task-id.mjs --dry-run --repo-root . --prefix flow
//   node allocate-task-id.mjs --write --repo-root . --prefix flow \
//        --content-file draft.md --slug my-new-task
//
// WRITES TO `main` BY DESIGN. Like the claim, this is store-plane work (CLAUDE.md: "state
// changes -> small commits to main"). Never run it from a feature branch — the caller is
// responsible for that; nothing in this file can enforce it, because by the time this file runs
// there is no "which branch am I on" signal a spoofed CI checkout couldn't fake.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readTasksFromOrigin } from "./flow-state.mjs";

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

export class AllocationError extends Error {}

export const DEFAULT_MAX_ATTEMPTS = 5;

// ── the two guards on the caller-supplied filename ────────────────────────────────────────
// This function writes a file and then `git add`s, commits and PUSHES IT TO `main` (see "WRITES
// TO `main` BY DESIGN" above). The name it writes comes from the caller — `filenameFor` here,
// `--slug` at the CLI — and `join()` NORMALISES `..`, so an unchecked name does not merely land
// in the wrong place: it escapes `.flow/tasks` entirely and lands anywhere under the repo root,
// committed straight to `main` with no PR and no review. Both guards below exist because either
// one alone leaves a hole: the regex cannot help a programmatic caller that supplies its own
// `filenameFor`, and the containment check cannot give a CLI user a message naming the flag.

// A slug is a filename fragment, not free text. Lowercase alphanumerics in hyphen-separated
// runs — no leading, trailing or doubled hyphens, no dots, no separators, so nothing that could
// traverse or hide an extension survives it.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Defence in depth, at the point the path is actually computed. `allocateTaskId` is exported,
// so `filenameFor` is an untrusted seam for every caller, not just `runCli`. A task file must be
// a DIRECT child of the store: the store is flat, so a name carrying any separator is wrong even
// when it does not escape.
export function assertInsideTasksDir(tasksDir, candidate) {
  const rel = relative(resolve(tasksDir), resolve(candidate));
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    throw new AllocationError(
      `allocate-task-id: refusing to write ${JSON.stringify(candidate)} — a task file must be a ` +
      `direct child of ${tasksDir}. \`join()\` normalises \`..\`, so an unchecked name escapes ` +
      `the store, and this transaction commits and pushes what it writes straight to \`main\`.`);
  }
  return candidate;
}
const DEFAULT_WIDTH = 4;

// ── pure: the allocation itself ─────────────────────────────────────────────────────────
// The widest zero-pad already in use among ids matching `prefix`, or DEFAULT_WIDTH when the
// store holds none yet. Derived, never assumed — a store that started at a different width
// keeps its own rather than being silently renumbered.
export function idWidth(ids, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const widths = (ids || []).map((id) => re.exec(String(id))?.[1]?.length).filter(Boolean);
  return widths.length ? Math.max(...widths) : DEFAULT_WIDTH;
}

// Maximum + 1, never the lowest free gap (see the task's notes: ids travel in branch names, PR
// titles and the automation's `[<id>]` match — reusing a retired number re-points that history
// at different work). `ids` is the FULL snapshot of ids present anywhere in the store, not
// filtered to `prefix` beforehand — this filters internally so a caller can pass every id
// `readTasksFromOrigin` returns without pre-processing.
export function nextId(ids, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const nums = (ids || []).map((id) => re.exec(String(id))?.[1]).filter(Boolean).map(Number);
  const width = idWidth(ids, prefix);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(width, "0")}`;
}

// ── impure: the one git seam, injected everywhere it's used ────────────────────────────────
function defaultGit(repoRoot) {
  return (args) => execFileSync("git", ["-C", repoRoot, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// `readTasksFromOrigin` reads `origin/main` via `git ls-tree` + `git show` — never the working
// tree, EXCEPT for its own documented fallback when `origin/main` itself can't be read. That
// fallback is right for a read-only status report; it is wrong here, because a fallback nobody
// notices is exactly how two allocators would both compute against stale, divergent state. So
// this wrapper refuses rather than silently degrading — the one place this module diverges from
// the resolver it reuses.
export function readIdsFromOrigin(repoRoot, reader = readTasksFromOrigin) {
  const { tasks, source } = reader(repoRoot);
  if (source.startsWith("WORKING TREE")) {
    throw new AllocationError(
      `allocate-task-id: origin/main unreadable (${source}) — refusing to allocate against ` +
      `unauthoritative state`);
  }
  return tasks.map((t) => t.id);
}

// ── the transaction ──────────────────────────────────────────────────────────────────────
// Fetch `origin/main` fresh, allocate, write the task file, commit, push. If the push is
// refused (someone else landed first), discard the attempt, re-fetch, re-sync and re-allocate
// — the id the next attempt lands on WILL differ — and retry, bounded by `maxAttempts`. On
// success returns `{ id, path, attempts }`. On exhaustion throws AllocationError, having left
// no commit and no file behind.
//
// Every seam is injected so this is exercisable without a network or a real remote:
//   - `readIds(repoRoot)`   -> string[]           (defaults to readIdsFromOrigin)
//   - `git(args)`           -> stdout | throws    (defaults to a real `git -C repoRoot ...`)
//   - `write(path, text)`, `remove(path)`         -> the fs seams
//
// Deliberately absent from the retry path: `pull`, `rebase`, `merge`, any `--force`/`-f` push.
// A `pull --rebase` here is the exact move that would replay a stale id past the refusal this
// function exists to catch — re-fetch + re-allocate is not a convenience, it's the fix.
export function allocateTaskId({
  repoRoot,
  prefix,
  filenameFor,
  buildContent,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  dryRun = false,
  readIds = (root) => readIdsFromOrigin(root),
  git = defaultGit(repoRoot),
  write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  remove = (path) => { if (existsSync(path)) unlinkSync(path); },
} = {}) {
  if (!repoRoot) throw new AllocationError("allocate-task-id: repoRoot is required");
  if (!prefix) throw new AllocationError("allocate-task-id: prefix is required");

  git(["fetch", "origin", "main", "--quiet"]);

  const tasksDir = join(repoRoot, ".flow", "tasks");
  let path = null;
  let id = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ids = readIds(repoRoot);
    id = nextId(ids, prefix);

    if (dryRun) return { id, path: null, attempts: attempt };

    // Checked BEFORE the write, not after: everything downstream (write, add, commit, push to
    // `main`) acts on this path, so the only safe place to refuse is before anything exists.
    const nextPath = assertInsideTasksDir(tasksDir, join(tasksDir, filenameFor(id)));
    write(nextPath, buildContent(id));
    path = nextPath;

    git(["add", "--", path]);
    git(["commit", "--quiet", "-m", `flow: allocate ${id}`]);

    try {
      git(["push", "origin", "HEAD:main"]);
      return { id, path, attempts: attempt };
    } catch {
      // Refused — someone else's push landed between our fetch and ours. Discard our attempt
      // entirely (the file this attempt wrote, and the commit built on the now-stale base) and
      // re-sync local `main` to the ref we just re-fetched. Deliberately a RESET, never a
      // `pull`, `rebase` or `merge` — those try to COMBINE our stale attempt with theirs, which
      // is the exact move that would silently replay a rejected id past the refusal this
      // function exists to catch. A reset just re-reads state, the same principle the claim
      // already relies on (CLAUDE.md: "if the push is rejected... rebase, re-read state, and
      // pick again" — here that's a hard reset, because there is no local work worth keeping;
      // the next attempt writes a fresh file under a fresh id from scratch).
      remove(path);
      git(["fetch", "origin", "main", "--quiet"]);
      git(["reset", "--hard", "refs/remotes/origin/main"]);
      path = null;
    }
  }

  if (path) remove(path);
  throw new AllocationError(
    `allocate-task-id: exhausted ${maxAttempts} attempt(s) without landing a push`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const USAGE = `allocate-task-id — first-push-wins task-id allocation.

  node allocate-task-id.mjs --dry-run --repo-root DIR --prefix PREFIX
  node allocate-task-id.mjs --write   --repo-root DIR --prefix PREFIX \\
       --content-file FILE --slug SLUG [--max-attempts N]

--dry-run   prints the id that would be allocated; writes, commits and pushes nothing.
--write     runs the real transaction: writes .flow/tasks/<id>-<slug>.md from FILE with its
            frontmatter \`id:\` line replaced, commits, and pushes to origin/main, retrying
            on a refused push up to --max-attempts (default ${DEFAULT_MAX_ATTEMPTS}).

Writes to \`main\` by design — never invoke --write from a feature branch.`;

export function buildContentFromFile(text, id) {
  return /^id:\s*.*$/m.test(text)
    ? text.replace(/^id:\s*.*$/m, `id: "${id}"`)
    : text;
}

export function runCli(argv, { log = console.log, logErr = console.error, cwd = process.cwd() } = {}) {
  const flags = parseFlags(argv);
  const repoRoot = resolve(cwd, flags["repo-root"] || ".");
  const prefix = flags.prefix;

  if (flags.help || (!flags["dry-run"] && !flags.write)) { log(USAGE); return flags.help ? 0 : 1; }
  if (!prefix) { logErr("allocate-task-id: --prefix is required"); return 1; }

  const maxAttempts = flags["max-attempts"] ? Number(flags["max-attempts"]) : DEFAULT_MAX_ATTEMPTS;

  try {
    if (flags["dry-run"]) {
      const { id } = allocateTaskId({ repoRoot, prefix, dryRun: true, maxAttempts,
        filenameFor: () => "", buildContent: () => "" });
      log(id);
      return 0;
    }

    const slug = flags.slug;
    const contentFile = flags["content-file"];
    if (!slug) { logErr("allocate-task-id: --slug is required with --write"); return 1; }
    // `--slug foo --write` parses `slug` as the boolean `true`; String(true) would sail through
    // the regex as "true", so the type is checked before the shape.
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      logErr("allocate-task-id: --slug must be lowercase alphanumeric in hyphen-separated runs " +
             `(e.g. my-new-task), got ${JSON.stringify(slug)}. It becomes part of a filename ` +
             "that is committed and pushed to main.");
      return 1;
    }
    if (!contentFile) { logErr("allocate-task-id: --content-file is required with --write"); return 1; }

    const raw = readFileSync(resolve(cwd, contentFile), "utf8");
    const { id, attempts } = allocateTaskId({
      repoRoot, prefix, maxAttempts,
      filenameFor: (allocated) => `${allocated}-${slug}.md`,
      buildContent: (allocated) => buildContentFromFile(raw, allocated),
    });
    log(`${id} (${attempts} attempt${attempts === 1 ? "" : "s"})`);
    return 0;
  } catch (err) {
    logErr(err instanceof AllocationError ? err.message : `allocate-task-id: ${err.message}`);
    return 1;
  }
}

if (__isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
