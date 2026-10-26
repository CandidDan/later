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

import { parseAsks } from "./asks.mjs";
import { parseListField, parseVisionGoals, MAINTENANCE_SERVES } from "./flow-doctor.mjs";


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
// The value of one frontmatter scalar, given the raw text that follows `key:`.
//
// In YAML a `#` opens a comment only OUTSIDE quotes, and that distinction is the whole of this
// function. The earlier version stripped a whitespace-preceded ` #…` from every scalar, quoted
// or not, which anticipated only a value that *starts* with a hash (`issue: "#157"` survived,
// because the strip needs leading whitespace). A hash in the MIDDLE of a quoted value did not:
// `blocked_reason: "waits on PR #127, not machine-checkable"` was cut to `"waits on PR`, so
// every reader downstream got a truncated reason, and the `not machine-checkable` opt-out that
// silences flow-doctor's empty-`blocked_by` warning was thrown away with it. A `#` inside quotes
// is data — a PR reference, a channel name, a CSS colour — and a parser that eats it corrupts
// prose silently, which is the worst way to be wrong.
//
// So: a quoted value is taken whole, up to its closing quote, and whatever follows (a real
// comment) is dropped. Only an UNQUOTED value has a trailing ` # comment` stripped. An
// unterminated quote falls through to the unquoted path, preserving the old lenient behaviour
// rather than throwing on a malformed store.
export function scalarValue(raw) {
  const s = String(raw ?? "").trim();
  const quoted = s.match(/^"([^"]*)"/) || s.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  return s.replace(/\s+#.*$/, "").trim();
}

// Same tolerant reader as pick-task / flow-doctor (inline-array touches, `#` comments,
// quoted scalars), extended to the lifecycle fields state resolution needs.
export function parseTask(text) {
  if (!text || !text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? scalarValue(m[1]) : "";
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
    // flow-0113. The intent this task derives from, empty if none. An intent's status is computed
    // by scanning tasks for this field; the intent itself never lists its tasks.
    intent: get("intent"),
    // flow-0119. Only the asks that PARSE: a malformed one is a flow-doctor failure on `main`,
    // and this resolver is read-only — it reports the store, it does not grade it. `[]` for every
    // task written before the field, so a consumer never has to test for its absence.
    asks: parseAsks(parseListField(head, "asks")).asks,
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
  return { id: task.id, title: task.title, store, resolved, detail, disagreement, asks: task.asks ?? [],
    // flow-0113. The PR URL the resolution rests on, else whatever the task file records.
    pr: (pr && pr.url) || task.pr || "", intent: task.intent ?? "" };
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

// ── intents and workstreams (flow-0113) ────────────────────────────────────
// The intent layer's status is DERIVED, never stored: an intent has no `tasks` list and no
// progress field, and a task names its intent. So the answer to "is this outcome done?" is a scan
// of tasks, and this is the one place that scan is written. inflight imports `buildIntentReport`
// and runs it on files it fetched, rather than restating the rule, so the rule cannot fork.
//
// Everything in this block is pure: raw file text in, plain data out. No git, gh or filesystem.

// Bumped on ANY breaking change to the JSON shape below. Consumers across repos pinned to
// different Flow versions branch on it.
export const REPORT_SCHEMA = 1;
export const INTENT_STATUSES = ["not_started", "in_progress", "blocked", "done", "superseded"];

// Frontmatter and body of one file. Tolerant like parseTask: null when there is no frontmatter.
function splitFile(text) {
  if (!text || !text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const nl = text.indexOf("\n", end + 1);
  return { head: text.slice(3, end), body: nl === -1 ? "" : text.slice(nl + 1) };
}
const fmGet = (head, k) => {
  const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
  return m ? scalarValue(m[1]) : "";
};

// `## Heading` -> text, keyed by a snake_case slug of the heading. Fenced code is not scanned.
function bodySections(body) {
  const out = {};
  let key = null, fence = false, buf = [];
  const flush = () => { if (key !== null) out[key] = buf.join("\n").trim(); buf = []; };
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && line.match(/^##\s+(.+?)\s*$/);
    if (h) { flush(); key = h[1].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); continue; }
    if (key !== null) buf.push(line);
  }
  flush();
  return out;
}

// A line beginning `[assumption]` (a list item counts) is detail the writer supplied that the human
// never said. `## Problem` holds only the human's words, so it is not scanned.
function assumptionLines(sections) {
  const out = [];
  for (const [k, text] of Object.entries(sections)) {
    if (k === "problem") continue;
    for (const line of text.split("\n")) {
      const t = line.trim().replace(/^[-*]\s+/, "");
      if (t.startsWith("[assumption]")) out.push(t);
    }
  }
  return out;
}

function resolveServes(ids, goals) {
  return ids.map((id) => {
    if (id === MAINTENANCE_SERVES) return { id, title: null, resolved: true, retired: false };
    const g = goals && goals.get(id.toUpperCase());
    return g ? { id, title: g.title, resolved: true, retired: !!g.retired } : { id, title: null, resolved: false, retired: false };
  });
}

// Pure: an intent's status from its own `status` and the tasks that name it. `tasks` carry the
// PR-reconciled `status` (or `resolved`) where the caller has it. A `cancelled` task is dead work
// and counts for nothing either way: an intent whose only task was cancelled has not started.
export function deriveIntentStatus(intent, tasks) {
  if (intent && intent.status === "superseded") return "superseded";
  const st = (tasks || []).map((t) => t.resolved ?? t.status).filter((s) => s !== "cancelled");
  if (!st.length) return "not_started";
  if (st.includes("blocked")) return "blocked";
  if (st.every((s) => s === "done")) return "done";
  return "in_progress";
}

const firstLine = (s) => String(s || "").split("\n")[0].trim();
const byCreatedThenId = (a, b) => String(a.created).localeCompare(String(b.created)) || String(a.id).localeCompare(String(b.id));
const mdEntries = (files) => Object.entries(files || {})
  .filter(([p]) => p.endsWith(".md") && !p.endsWith("_TEMPLATE.md"));

// Pure: the whole report from raw file text keyed by path. `prs` is optional (the `gh` list); with
// none, task status is the store's. Returns exactly the fields `--json` prints for the layer.
export function buildIntentReport({ workstreams = {}, intents = {}, tasks = {}, vision = "", prs = [] } = {}) {
  const goals = vision ? parseVisionGoals(vision).goals : null;

  const intentRows = [];
  for (const [path, text] of mdEntries(intents)) {
    const f = splitFile(text);
    const id = f && fmGet(f.head, "id");
    if (!id) continue;
    intentRows.push({ path, head: f.head, body: f.body, id });
  }
  if (!intentRows.length) return { schema: REPORT_SCHEMA, intent_layer: "inactive", workstreams: [], intents: [] };

  const wsRows = [];
  for (const [, text] of mdEntries(workstreams)) {
    const f = splitFile(text);
    const id = f && fmGet(f.head, "id");
    if (!id) continue;
    const s = bodySections(f.body);
    wsRows.push({
      id, title: fmGet(f.head, "title"), created: fmGet(f.head, "created"),
      status: fmGet(f.head, "status"), owner: fmGet(f.head, "owner"),
      serves: resolveServes(parseListField(f.head, "serves"), goals),
      purpose: s.purpose ?? "", constraints: s.constraints ?? "",
      dependencies: s.dependencies ?? "", open_questions: s.open_questions ?? "",
    });
  }
  const wsIds = new Set(wsRows.map((w) => w.id));

  const parsedTasks = Object.values(tasks).map(parseTask).filter(Boolean);
  const reasons = new Map(parsedTasks.map((t) => [t.id, t.blocked_reason]));
  const resolvedTasks = reconcile(parsedTasks, prs);
  const supersededBy = new Map();
  for (const r of intentRows) {
    const sup = fmGet(r.head, "supersedes");
    if (sup && !supersededBy.has(sup)) supersededBy.set(sup, r.id);
  }

  const intentOut = intentRows.map((r) => {
    const named = resolvedTasks.filter((t) => t.intent === r.id);
    const status = deriveIntentStatus({ status: fmGet(r.head, "status") }, named);
    const blocker = status === "blocked" ? named.find((t) => t.resolved === "blocked") : null;
    const s = bodySections(r.body);
    const ws = fmGet(r.head, "workstream");
    return {
      id: r.id, title: fmGet(r.head, "title"), created: fmGet(r.head, "created"),
      source: fmGet(r.head, "source"),
      workstream: ws || null, stream_resolved: !ws || wsIds.has(ws),
      serves: resolveServes(parseListField(r.head, "serves"), goals),
      status,
      blocked_reason: blocker ? firstLine(reasons.get(blocker.id)) : "",
      tasks: named.map((t) => ({ id: t.id, status: t.resolved, pr: t.pr })),
      supersedes: fmGet(r.head, "supersedes"), superseded_by: supersededBy.get(r.id) ?? "",
      problem: s.problem ?? "", cost_of_inaction: s.cost_of_inaction ?? "", outcome: s.outcome ?? "",
      constraints: s.constraints ?? "", open_questions: s.open_questions ?? "",
      assumptions: assumptionLines(s),
    };
  }).sort(byCreatedThenId);

  const wsOut = wsRows.sort(byCreatedThenId).map((w) => {
    const counts = Object.fromEntries(INTENT_STATUSES.map((k) => [k, 0]));
    for (const i of intentOut) if (i.workstream === w.id) counts[i.status]++;
    const { created, ...rest } = w;
    return { ...rest, counts };
  });
  return { schema: REPORT_SCHEMA, intent_layer: "active", workstreams: wsOut, intents: intentOut };
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
  const git = readTextsFromOrigin(repoRoot, ".flow/tasks");
  const tasks = [];
  for (const text of Object.values(git.files)) {
    const t = parseTask(text);
    if (t) tasks.push(t);
  }
  if (git.fromGit) {
    const commit = (trySh("git", ["-C", repoRoot, "log", "-1", "--format=%h %cd", "--date=short", "origin/main"]) || "").trim();
    return { tasks, texts: git.files, source: `origin/main${commit ? ` @ ${commit}` : ""}` };
  }
  return { tasks, texts: git.files, source: "WORKING TREE (origin/main unreadable — may be STALE)" };
}

// Every `.md` under `dir` as { path: text }, from origin/main when it is readable and from the
// working tree only when it is not (`fromGit: false`, the same loud fallback as tasks). A
// directory that does not exist on origin/main is `{}`: the layer is simply absent.
export function readTextsFromOrigin(repoRoot, dir) {
  const inGit = trySh("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
  if (inGit && inGit.trim() === "true") {
    const listing = trySh("git", ["-C", repoRoot, "ls-tree", "-r", "--name-only", "origin/main", dir]);
    if (listing !== null) {
      const files = {};
      for (const path of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!path.endsWith(".md") || path.endsWith("_TEMPLATE.md")) continue;
        const text = trySh("git", ["-C", repoRoot, "show", `origin/main:${path}`]);
        if (text !== null) files[path] = text;
      }
      return { files, fromGit: true };
    }
  }
  const abs = join(repoRoot, dir);
  const files = {};
  if (existsSync(abs)) {
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
      files[`${dir}/${name}`] = readFileSync(join(abs, name), "utf8");
    }
  }
  return { files, fromGit: false };
}

function readVision(repoRoot, fromGit) {
  if (fromGit) return trySh("git", ["-C", repoRoot, "show", "origin/main:VISION.md"]) ?? "";
  const p = join(repoRoot, "VISION.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
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

// Human-readable intents: one line per workstream with its counts, one per ungrouped intent.
// An intent naming an undeclared workstream is ungrouped here too, flagged, so it is not lost.
function writeIntentSummary(out, report) {
  if (report.intent_layer !== "active") return;
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  out.write("\nintents:\n");
  for (const w of report.workstreams) {
    const c = w.counts;
    out.write(`  ${pad(w.id, 28)} [${w.status || "?"}] ${c.done} done · ${c.in_progress} in progress · ${c.blocked} blocked · ${c.not_started} not started` +
      `${c.superseded ? ` · ${c.superseded} superseded` : ""}\n`);
  }
  for (const i of report.intents.filter((x) => !x.workstream || !x.stream_resolved)) {
    out.write(`  ${pad(i.id, 28)} ${i.status}${i.stream_resolved ? "" : ` (workstream '${i.workstream}' not declared)`}\n`);
  }
}

function writeIntent(out, i) {
  out.write(`${i.id} — ${i.title}\nstatus: ${i.status}${i.blocked_reason ? ` (${i.blocked_reason})` : ""}\n`);
  out.write(`workstream: ${i.workstream ?? "(none)"}${i.stream_resolved ? "" : " — not declared"}\n`);
  out.write(i.tasks.length ? "tasks:\n" : "tasks: none name this intent\n");
  for (const t of i.tasks) out.write(`  ${t.id}  ${t.status}  ${t.pr || "(no PR)"}\n`);
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

  const { tasks, texts, source } = readTasksFromOrigin(repoRoot);
  const { prs, ok: prOk, why: prWhy } = noPr ? { prs: [], ok: false, why: "skipped (--no-pr)" } : readPrs(repoRoot);

  const fromGit = !source.startsWith("WORKING TREE");
  const report = buildIntentReport({
    workstreams: readTextsFromOrigin(repoRoot, ".flow/workstreams").files,
    intents: readTextsFromOrigin(repoRoot, ".flow/intents").files,
    tasks: texts, vision: readVision(repoRoot, fromGit), prs,
  });

  let rows = reconcile(tasks, prs);
  const intent = idArg && report.intents.find((i) => i.id.toLowerCase() === idArg.toLowerCase());
  if (intent) rows = [];
  else if (idArg) rows = rows.filter((r) => r.id.toLowerCase() === idArg.toLowerCase() || String(idNum(r.id)) === idArg.replace(/\D/g, ""));

  if (asJson) {
    out.write(JSON.stringify({
      schema: report.schema, source, prReconciled: prOk, prNote: prOk ? undefined : prWhy, tasks: rows,
      intent_layer: report.intent_layer, workstreams: report.workstreams, intents: report.intents,
    }, null, 2) + "\n");
    return 0;
  }

  out.write(`state source: ${source}\n`);
  out.write(`PR reconcile: ${prOk ? `${prs.length} PRs` : `off — ${prWhy}`}\n\n`);
  if (intent) { writeIntent(out, intent); return 0; }
  if (!rows.length) { out.write(idArg ? `No task '${idArg}' found on ${source}.\n` : "No tasks found.\n"); return 0; }

  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  const warns = [];
  for (const r of rows) {
    out.write(`${pad(r.id, 9)} ${pad(r.resolved, 12)} ${r.detail}\n`);
    if (r.disagreement) warns.push(`  ⚠ ${r.id}: ${r.disagreement}`);
  }
  if (warns.length) { out.write("\n" + warns.join("\n") + "\n"); }
  if (!idArg) writeIntentSummary(out, report);
  return 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────
// The template's own root: `.flow/bin` -> `.flow` -> repo. In an adopting repo that IS the
// repo; in canonical it is `project-template/`, which is why canonical adapts (see above).
if (__isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(runStateCli({ repoRoot, argv: process.argv.slice(2) }));
}
