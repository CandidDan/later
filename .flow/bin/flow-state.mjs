#!/usr/bin/env node
// flow-state.mjs — the trusted, on-demand state resolver. Pure core, zero-dependency (Node >= 18).
//
// THE PROBLEM IT SOLVES. Three copies of "the truth" exist and none is trusted:
//   1. a sandbox git clone — stale, no auth to fetch;
//   2. the Mac working tree — its *files* lag, because `flow-fetch` refreshes the
//      `origin/main` REF but never merges it into the working copy;
//   3. GitHub — the real PR lifecycle events, which only reach a task file when a
//      workflow writes them back.
// So every "is CAN-94 done?" turns into a Chrome trip + asking the human. This closes that:
// it reads task state from `origin/main` (the one authoritative, flow-fetch-fresh layer —
// NEVER the working tree) and, when `gh` is available, reconciles each task against its PR.
//
//   node .flow/bin/flow-state.mjs              # resolved state of every task, one line each
//   node .flow/bin/flow-state.mjs CAN-94       # just that task, with detail
//   node .flow/bin/flow-state.mjs --json       # machine-readable
//   node .flow/bin/flow-state.mjs --no-pr      # store-only (skip gh reconciliation)
//   node .flow/bin/flow-state.mjs --fetch      # force a `git fetch origin main` first
//
// WHERE TO RUN IT. On the Mac (or any clone with auth) you get the full picture — store
// from origin/main + PR reconciliation via gh. In a sandbox it still reads origin/main
// (fresh, because flow-fetch keeps the ref current in the mounted repo) and simply skips
// PR reconciliation when gh isn't authed — which is enough, since FLOW_PAT makes the
// writeback reliable and the store on origin/main is usually self-sufficient.
//
// It is READ-ONLY. It never writes a task file, never commits, never opens a PR.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
// ── pure: frontmatter parse ────────────────────────────────────────────────
// Same tolerant reader as pick-task / flow-doctor (inline-array touches, `#` comments,
// quoted scalars), extended to the lifecycle fields state resolution needs.
export function parseTask(text) {
  if (!text || !text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    // Strip only a whitespace-preceded ` # comment` (YAML rule) — NOT a `#` inside the
    // value, so `issue: "#157"` and other hash-bearing values survive intact.
    return m ? m[1].replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1") : "";
  };
  const id = get("id");
  if (!id) return null;
  return {
    id,
    title: get("title"),
    status: get("status"),
    priority: parseInt(get("priority"), 10),
    owner: get("owner"),
    branch: get("branch"),
    pr: get("pr"),
    blocked_reason: get("blocked_reason"),
    issue: get("issue"),
  };
}

// The numeric suffix of an id, for matching a PR's flow/<id>-slug branch and for sorting.
export function idNum(id) {
  const m = String(id).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

// Does a PR (by its head branch name) belong to this task? Flow branches are `flow/<id>-slug`.
// Match is case-insensitive on the id token and anchored so CAN-9 doesn't match CAN-94.
export function branchMatchesTask(branch, id) {
  if (!branch) return false;
  const re = new RegExp(`(^|/)flow/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-|$)`, "i");
  return re.test(branch);
}

// ── pure: the resolution core (the unit-tested heart) ──────────────────────
// Given a parsed task and the PR that belongs to it (or null), return the RESOLVED
// lifecycle truth plus any disagreement between what the store claims and what the PR
// proves. `pr` shape: { number, state: 'OPEN'|'MERGED'|'CLOSED', url } or null.
//
// PR reality wins over the store field, because a merged/closed/open PR is a fact and the
// store field is only as current as the last successful writeback. A disagreement is not an
// error — it's exactly the signal worth surfacing (a writeback that lagged or never fired).
export function resolveState(task, pr) {
  const store = task.status || "(none)";
  let resolved, detail, disagreement = null;

  if (pr && pr.state === "MERGED") {
    resolved = "done";
    detail = `merged in #${pr.number}`;
    if (store !== "done") disagreement = `store says '${store}' but PR #${pr.number} is merged — flow-done writeback lagged`;
  } else if (pr && pr.state === "OPEN") {
    resolved = "in_review";
    detail = `PR #${pr.number} open`;
    if (store !== "in_review") disagreement = `store says '${store}' but PR #${pr.number} is open — flow-status writeback lagged`;
  } else if (pr && pr.state === "CLOSED") {
    resolved = "ready";
    detail = `PR #${pr.number} closed unmerged — back to ready`;
    if (store !== "ready") disagreement = `store says '${store}' but PR #${pr.number} was closed unmerged — should be back to ready`;
  } else {
    // No PR found. Read the store field, but sanity-check the ones that IMPLY a PR.
    switch (store) {
      case "ready":
        resolved = "ready"; detail = "unclaimed, no PR"; break;
      case "in_progress":
        resolved = "in_progress";
        detail = task.owner ? `claimed by ${task.owner}, no PR yet` : "claimed, no owner recorded, no PR yet";
        break;
      case "in_review":
        resolved = "in_review"; detail = "store says in_review";
        disagreement = "store says 'in_review' but no open PR was found — stale writeback or PR closed outside Flow";
        break;
      case "blocked":
        resolved = "blocked"; detail = task.blocked_reason ? `blocked: ${task.blocked_reason}` : "blocked (no reason recorded)"; break;
      case "done":
        resolved = "done"; detail = "done (no PR link on file)"; break;
      default:
        resolved = store; detail = "no PR"; break;
    }
  }
  return { id: task.id, title: task.title, store, resolved, detail, disagreement };
}

// Pure: pick the PR belonging to a task from a list of PRs. Prefers an explicit `pr:` URL
// match on the task, then a flow/<id>- branch match. Among branch matches, an OPEN or
// MERGED PR beats a CLOSED one (a reopened/superseded branch shouldn't mask the real state).
export function pickPrForTask(task, prs) {
  const byUrl = task.pr && prs.find((p) => p.url && task.pr && p.url === task.pr);
  if (byUrl) return byUrl;
  const byNum = task.pr && prs.find((p) => String(p.number) === (task.pr.match(/(\d+)\s*$/) || [])[1]);
  if (byNum) return byNum;
  const matches = prs.filter((p) => branchMatchesTask(p.headRefName, task.id));
  if (!matches.length) return null;
  const rank = (s) => (s === "MERGED" ? 0 : s === "OPEN" ? 1 : 2);
  return matches.slice().sort((a, b) => rank(a.state) - rank(b.state) || b.number - a.number)[0];
}

// Pure: resolve a whole set of tasks against a set of PRs. Sorted by id number ascending.
export function reconcile(tasks, prs) {
  return tasks
    .slice()
    .sort((a, b) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(b.id))
    .map((t) => resolveState(t, pickPrForTask(t, prs)));
}

// ── impure: thin shells over git + gh (stay out of the pure core above) ────
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts });
}
function trySh(cmd, args, opts = {}) {
  try { return sh(cmd, args, opts); } catch { return null; }
}

// Read every task on origin/main (NOT the working tree). Returns { tasks, source }.
// Falls back to the working tree only if origin/main is unreadable, and says so loudly.
//
// Exported because canonical adopts this file through a `.flow/bin/` adapter rather than a
// copy, and the adapter needs the same reader pointed at a different repo root. The `WORKING
// TREE` prefix on `source` is a CONTRACT, not a cosmetic string: flightdeck-state refuses any
// project whose resolver fell back to it. Two implementations of that could drift apart
// silently, so there is one.
export function readTasksFromOrigin(repoRoot) {
  const inGit = trySh("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (inGit && inGit.trim() === "true") {
    const listing = trySh("git", ["-C", repoRoot, "ls-tree", "-r", "--name-only", "origin/main", ".flow/tasks"]);
    if (listing !== null) {
      const tasks = [];
      for (const path of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!path.endsWith(".md") || path.endsWith("_TEMPLATE.md")) continue;
        const text = trySh("git", ["-C", repoRoot, "show", `origin/main:${path}`]);
        const t = parseTask(text);
        if (t) tasks.push(t);
      }
      const commit = (trySh("git", ["-C", repoRoot, "log", "-1", "--format=%h %cd", "--date=short", "origin/main"]) || "").trim();
      return { tasks, source: `origin/main${commit ? ` @ ${commit}` : ""}` };
    }
  }
  // Fallback — read the working tree, but flag it as NOT authoritative.
  const dir = join(repoRoot, ".flow", "tasks");
  const tasks = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
      const t = parseTask(readFileSync(join(dir, name), "utf8"));
      if (t) tasks.push(t);
    }
  }
  return { tasks, source: "WORKING TREE (origin/main unreadable — may be STALE)" };
}

// Pull every PR via one gh call. Returns [] and a note if gh is unavailable/unauthed.
// Exported alongside readTasksFromOrigin, for the same reason.
export function readPrs(repoRoot) {
  if (!trySh("gh", ["--version"])) return { prs: [], ok: false, why: "gh not installed" };
  const out = trySh("gh", ["pr", "list", "--state", "all", "--limit", "300",
    "--json", "number,state,headRefName,url,title"], { cwd: repoRoot });
  if (out === null) return { prs: [], ok: false, why: "gh not authed / no PR access" };
  try { return { prs: JSON.parse(out), ok: true }; }
  catch { return { prs: [], ok: false, why: "could not parse gh output" }; }
}

// ── the CLI shell, as a function ───────────────────────────────────────────
// Everything the command does, with the two things that vary injected: WHICH repo root to
// resolve state from, and where to write. Canonical's `.flow/bin/flow-state.mjs` adapter calls
// this with its own repo root — the reason this is a function and not an inline `if (__isMain)`
// block. Returns the exit code; it never calls process.exit, so a test can drive it directly.
//
// The repo root is a REQUIRED argument on purpose. Defaulting it to this file's own location
// would make the adapter's whole job optional, and getting it wrong is silent: every command
// still exits 0, having reported the template's fixture store as if it were the real one.
export function runStateCli({ repoRoot, argv = [], out = process.stdout } = {}) {
  const asJson = argv.includes("--json");
  const noPr = argv.includes("--no-pr");
  const doFetch = argv.includes("--fetch");
  const idArg = argv.find((a) => !a.startsWith("--"));

  if (doFetch) trySh("git", ["-C", repoRoot, "fetch", "origin", "main", "--quiet"]);

  const { tasks, source } = readTasksFromOrigin(repoRoot);
  const { prs, ok: prOk, why: prWhy } = noPr ? { prs: [], ok: false, why: "skipped (--no-pr)" } : readPrs(repoRoot);

  let rows = reconcile(tasks, prs);
  if (idArg) rows = rows.filter((r) => r.id.toLowerCase() === idArg.toLowerCase() || String(idNum(r.id)) === idArg.replace(/\D/g, ""));

  if (asJson) {
    out.write(JSON.stringify({ source, prReconciled: prOk, prNote: prOk ? undefined : prWhy, tasks: rows }, null, 2) + "\n");
    return 0;
  }

  out.write(`state source: ${source}\n`);
  out.write(`PR reconcile: ${prOk ? `${prs.length} PRs` : `off — ${prWhy}`}\n\n`);
  if (!rows.length) { out.write(idArg ? `No task '${idArg}' found on ${source}.\n` : "No tasks found.\n"); return 0; }

  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  const warns = [];
  for (const r of rows) {
    out.write(`${pad(r.id, 9)} ${pad(r.resolved, 12)} ${r.detail}\n`);
    if (r.disagreement) warns.push(`  ⚠ ${r.id}: ${r.disagreement}`);
  }
  if (warns.length) { out.write("\n" + warns.join("\n") + "\n"); }
  return 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────
// The template's own root: `.flow/bin` -> `.flow` -> repo. In an adopting repo that IS the
// repo; in canonical it is `project-template/`, which is why canonical adapts (see above).
if (__isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(runStateCli({ repoRoot, argv: process.argv.slice(2) }));
}
