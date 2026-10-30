#!/usr/bin/env node
// flow-unblock.mjs — release a blocked task once everything it waits on has landed.
//
// `blocked` is the one status with no automated exit. flow-status owns `in_review` and the return
// to `ready`, flow-done owns `done`, flow-recover heals a stranded `in_progress` — and a blocked
// task waited for someone to notice its dependency had merged. That failure is quiet: the store
// looks healthy, nothing turns red, and the work simply never happens. flow-0040 made the
// dependency machine-readable (`blocked_by`); this is the half that acts on it.
//
// It is a SWEEP, not an event hook: every run re-reads the whole store, so a block written after
// its dependency landed is still released, and a missed run loses nothing. The workflow fires it
// on flow-done completing (fast), hourly (the self-correcting backstop) and on demand.
//
// This module is the pure classifier, in the shape flow-recover.mjs established: the module
// decides, `_flow-unblock.yml` does the git/gh I/O. The safety property everything else rests on:
// a block the machine cannot FULLY read is a block only a human may lift. An empty `blocked_by`,
// an entry that is not a task id or a PR url, a task id the store does not hold, a PR the token
// could not read — every one of those keeps the task blocked.
//
//   node .flow/bin/flow-unblock.mjs pr-refs           # "<url>\t<owner>/<repo>\t<number>" to look up
//   node .flow/bin/flow-unblock.mjs plan  --pr-facts f # "<id>\t<decision>\t<detail>" per blocked task
//   node .flow/bin/flow-unblock.mjs edits --pr-facts f # the board-edits JSON for every release
//
// The PR facts file is what the workflow learned from `gh api repos/<owner>/<repo>/pulls/<n>`,
// one line per PR: "<url>\t<state>\t<merged>" (`open|closed`, `true|false`), or
// "<url>\tunknown\t" when the lookup failed.
//
// Zero dependencies (Node >= 18).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBlockedByEntry, parseListField, yamlScalar } from "./flow-doctor.mjs";


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

// ── Resolving one `blocked_by` entry ─────────────────────────────────────────────────────
//
// Each entry resolves to exactly one of:
//   "satisfied"       — a task id that is `done` on main, or a PR url that MERGED
//   "pending"         — a task that exists and is not done, or a PR that is still open
//   "closed-unmerged" — a PR closed WITHOUT merging: the premise of the block did not happen, so
//                       it is not satisfied, and it is reported apart from "pending" because no
//                       amount of waiting will ever satisfy it — a person has to look
//   "unknown"         — anything the sweep could not establish: a malformed entry, an id the
//                       store does not hold, a url that is not a GitHub PR, a PR it could not read
//
// Only "satisfied" counts towards a release. "unknown" is deliberately not a soft "pending":
// it is a separate fact so the report can say WHY a task stayed, but it has the same effect.

const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;

// The `{ url, repo, number }` of a GitHub PR url, or null. Strict on purpose: `repo` and `number`
// reach `gh api repos/<repo>/pulls/<number>` as an argument, so only a shape that cannot carry
// anything else is let through. A url with a query, a fragment or a sub-page is not a PR reference
// this sweep will act on — it resolves "unknown" and the task stays blocked.
export function parsePrUrl(entry) {
  const m = String(entry ?? "").trim().match(PR_URL_RE);
  if (!m || m[1].startsWith(".") || m[2].startsWith(".")) return null;
  return { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

// tasks: Map<id, status> of the store on main. prFacts: Map<url, { state, merged } | "unknown">.
export function resolveEntry(entry, { tasks = new Map(), prFacts = new Map() } = {}) {
  const v = String(entry ?? "").trim();
  if (!isBlockedByEntry(v)) return "unknown";
  const pr = parsePrUrl(v);
  if (pr) {
    const f = prFacts.get(pr.url);
    if (!f || f === "unknown") return "unknown";
    if (f.merged === true) return "satisfied";
    if (f.state === "closed" && f.merged === false) return "closed-unmerged";
    if (f.state === "open") return "pending";
    return "unknown";
  }
  if (/^https?:\/\//.test(v)) return "unknown";      // a url, but not one this sweep can resolve
  if (!tasks.has(v)) return "unknown";               // dangling: never release on a missing task
  return tasks.get(v) === "done" ? "satisfied" : "pending";
}

// ── The classifier ───────────────────────────────────────────────────────────────────────
//
// Given a task ({ status, blockedBy }) and the resolution of each entry, return exactly one of:
//   "not-blocked"     — the task is not `blocked`; it is never released, whatever blocked_by holds
//   "unreadable"      — blocked, with an empty or absent blocked_by: only a human may lift it
//   "closed-unmerged" — at least one PR entry closed without merging; stays blocked, surfaced
//   "waiting"         — at least one entry is pending or unknown; stays blocked
//   "release"         — EVERY entry is satisfied; move it back to `ready`
//
// `closed-unmerged` outranks `waiting` because it is the one a person must act on: a task waiting
// on an open PR and on an abandoned one will never be released by waiting for the open one.
export function classifyBlocked(task, resolutions = []) {
  if (!task || task.status !== "blocked") return "not-blocked";
  const entries = (task.blockedBy ?? []).map((e) => String(e).trim()).filter(Boolean);
  if (entries.length === 0) return "unreadable";
  // A resolution per entry, or the task is not fully resolved — never release on a short list.
  if (!Array.isArray(resolutions) || resolutions.length !== entries.length) return "waiting";
  if (resolutions.includes("closed-unmerged")) return "closed-unmerged";
  if (resolutions.every((r) => r === "satisfied")) return "release";
  return "waiting";
}

// The board-edit that releases a task: back to `ready`, with the prose and the dependency list of
// the block cleared, and nothing else. Never `in_progress`: the sweep restores eligibility, it does
// not claim — claiming stays first-push-wins among workers. Applied through apply-board-edits.mjs
// as a commit to main, never a hand-edit.
export function buildReleaseEdit(id) {
  return { id, status: "ready", blocked_reason: "", blocked_by: [] };
}

// ── Reading the store ────────────────────────────────────────────────────────────────────

function parseTask(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? yamlScalar(m[1]) : "";
  };
  const id = get("id");
  if (!id) return null;
  return { id, status: get("status"), blockedBy: parseListField(head, "blocked_by") };
}

// Every task file in a tasks dir (skips _TEMPLATE.md and non-.md), as { id, status, blockedBy }.
export function readTasks(tasksDir) {
  const out = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (t) out.push(t);
  }
  return out;
}

// The PRs the workflow must look up: every PR-url entry of every BLOCKED task, deduped. Nothing
// else is asked about, so a populated `blocked_by` on a done task costs no API call.
export function prRefs(tasks) {
  const seen = new Map();
  for (const t of tasks) {
    if (t.status !== "blocked") continue;
    for (const e of t.blockedBy ?? []) {
      const pr = parsePrUrl(e);
      if (pr && !seen.has(pr.url)) seen.set(pr.url, pr);
    }
  }
  return [...seen.values()];
}

// Parse the facts file (see the header). A line that does not parse is simply absent, which
// resolves its PR "unknown" — the same as a failed lookup, which is the safe direction.
export function parsePrFacts(text) {
  const facts = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const [url, state, merged] = line.split("\t").map((s) => (s ?? "").trim());
    const pr = parsePrUrl(url);
    if (!pr) continue;
    if (state === "unknown") { facts.set(pr.url, "unknown"); continue; }
    if (!["open", "closed"].includes(state) || !["true", "false"].includes(merged)) continue;
    facts.set(pr.url, { state, merged: merged === "true" });
  }
  return facts;
}

// Classify every blocked task in the store. Returns [{ id, decision, detail }], where `detail`
// names each entry that is not satisfied and why — the line a person reads in the run log.
export function planReleases(tasks, prFacts = new Map()) {
  const statuses = new Map(tasks.map((t) => [t.id, t.status]));
  const out = [];
  for (const t of tasks) {
    if (t.status !== "blocked") continue;
    const entries = (t.blockedBy ?? []).map((e) => String(e).trim()).filter(Boolean);
    const resolutions = entries.map((e) => resolveEntry(e, { tasks: statuses, prFacts }));
    const decision = classifyBlocked(t, resolutions);
    const detail = decision === "unreadable"
      ? "no blocked_by entry — only a human may lift this block"
      : entries.map((e, i) => `${e}=${resolutions[i]}`).filter((s) => !s.endsWith("=satisfied")).join(", ");
    out.push({ id: t.id, decision, detail });
  }
  return out;
}

// It starts no worker (flow-0173): the next worker run picks the released task. The four
// dispatch-only helpers that used to follow here went with the queue-runner (flow-0174, retired).

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
//
// ONE CLI, two callers — exported because canonical's `.flow/bin/flow-unblock.mjs` adapter runs
// it against canonical's own store (see flow-recover.mjs's runRecoverCli for the drift a copied
// CLI produced). `tasksDir` is the store to read; `readFile` and `out` are injectable so
// a test can drive it in-process. Always returns 0: a scheduled sweep degrades to a no-op.

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export function runUnblockCli(argv, opts = {}) {
  const { tasksDir } = opts;
  const out = opts.out || process.stdout;
  const readFile = opts.readFile || ((p) => {
    try { return readFileSync(p, "utf8"); } catch { return ""; }
  });
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  const facts = () => parsePrFacts(f["pr-facts"] ? readFile(f["pr-facts"]) : "");

  if (cmd === "pr-refs") {
    for (const r of prRefs(readTasks(tasksDir))) out.write(`${r.url}\t${r.repo}\t${r.number}\n`);
  } else if (cmd === "plan") {
    for (const p of planReleases(readTasks(tasksDir), facts())) {
      out.write(`${p.id}\t${p.decision}\t${p.detail}\n`);
    }
  } else if (cmd === "edits") {
    const updates = planReleases(readTasks(tasksDir), facts())
      .filter((p) => p.decision === "release").map((p) => buildReleaseEdit(p.id));
    out.write(JSON.stringify({ updates }) + "\n");
  } else {
    process.stderr.write("usage: flow-unblock.mjs <pr-refs|plan|edits> …\n");
  }
  return 0;
}

if (__isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(runUnblockCli(process.argv.slice(2), { tasksDir: join(flowDir, "tasks") }));
}
