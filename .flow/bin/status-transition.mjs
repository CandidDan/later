#!/usr/bin/env node
// status-transition.mjs — what flow-status may write, given the task's status in the store.
//
// `_flow-status.yml` turns PR events into status changes. Two of them must look at the task first:
//   · a DRAFT PR opening on a `blocked` task records branch + pr and keeps the block (flow-0169);
//   · a PR closing unmerged on a `cancelled` task writes NOTHING and does not escalate its model
//     (flow-0176). `cancelled` is terminal and only a human reverses it. The orchestrator cancels
//     a task and then closes its PR, so the close used to reset every cancelled task to `ready`,
//     where pick-task could claim it again (flow-0171, 2026-10-28).
//
//   node .flow/bin/status-transition.mjs status --id <id>
//     prints the task's frontmatter `status` ("" when the task is not found). Exit 0.
//   node .flow/bin/status-transition.mjs closed --id <id> [--event-pr <N>] [--edits <file>]
//     exit 0 = reset to ready (and, with --edits, writes that edit to <file>);
//     exit 3 = the task is cancelled: prints the leave-alone line, writes nothing.
//
// The store is `.flow/tasks/` next to this `bin/` directory; canonical's adapter passes its own.
// Zero dependencies (Node >= 18).

import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The frontmatter of a task file ("" when it has none). A `status:` line in the body is prose.
function frontmatter(src) {
  const s = String(src);
  if (!s.startsWith("---")) return "";
  const end = s.indexOf("\n---", 3);
  return end === -1 ? s : s.slice(0, end);
}

// The frontmatter `status` of a task file ("" when absent).
export function readStatus(src) {
  const m = frontmatter(src).match(/^status:[ \t]*"?([a-z_]*)"?[ \t]*$/m);
  return m ? m[1] : "";
}

// The source of the task whose frontmatter `id` is `id` ("" when there is none).
export function readTask(tasksDir, id) {
  let names;
  try { names = readdirSync(tasksDir).filter((n) => n.endsWith(".md")).sort(); } catch { return ""; }
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idLine = new RegExp(`^id:[ \\t]*"?${esc}"?[ \\t]*$`, "m");
  for (const n of names) {
    const src = readFileSync(join(tasksDir, n), "utf8");
    if (idLine.test(frontmatter(src))) return src;
  }
  return "";
}

// Pure decision for a PR closed without merging. `leave` writes nothing and escalates nothing.
export function closedUnmerged({ id, status, eventPr }) {
  const pr = eventPr ? `PR #${eventPr}` : "PR";
  if (status === "cancelled") {
    return {
      verdict: "leave",
      updates: [],
      line: `${pr} closed unmerged: ${id} is cancelled — left unchanged (no status, owner, branch, pr or model edit)`,
    };
  }
  return {
    verdict: "ready",
    updates: [{ id, status: "ready", owner: "", branch: "", pr: "" }],
    line: `${pr} closed unmerged -> ${id} back to ready`,
  };
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

const SUBCOMMANDS = {
  status: ({ status }) => ({ code: 0, stdout: status + "\n" }),
  closed: ({ f, status }) => {
    const d = closedUnmerged({ id: f.id, status, eventPr: f["event-pr"] });
    if (d.verdict === "leave") return { code: 3, stdout: d.line + "\n" };
    if (f.edits) writeFileSync(f.edits, JSON.stringify({ updates: d.updates }) + "\n");
    return { code: 0, stdout: d.line + "\n" };
  },
};

// The CLI as a function: { code, stdout }.
export function main(argv, { tasksDir }) {
  const f = parseFlags(argv);
  const run = SUBCOMMANDS[f._[0]];
  if (!f.id || !run) {
    return { code: 2, stdout: "usage: status-transition.mjs status|closed --id <id> [--event-pr <N>] [--edits <file>]\n" };
  }
  return run({ f, status: readStatus(readTask(tasksDir, f.id)) });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const r = main(process.argv.slice(2), { tasksDir: join(flowDir, "tasks") });
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
