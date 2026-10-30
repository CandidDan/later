#!/usr/bin/env node
// pr-of-record.mjs — a task that already has an open PR keeps it (flow-0162).
//
// Flow keys everything off the branch pattern `flow/<id>-…`, so when a second branch carries the
// same id (an owner-approved helper split, say) every push and PR event on it was read as THE
// task's: a draft PR per push, `branch`/`pr`/`status` overwritten, and — when the strays were
// closed — the task reset to `ready` and its model escalated while its real PR was in review.
//
// The rule: the task's PR OF RECORD is the PR its `pr:` field names ON MAIN, while that PR is OPEN.
// An event on any other PR is FOREIGN and changes nothing. With no `pr:`, or a closed/merged one,
// there is no record and behaviour is as it always was. `pr:` is read from origin/main, never from
// the pushed branch: a worker branch carries a frozen copy of the task file, wrong exactly here.
//
//   node .flow/bin/pr-of-record.mjs --id <id> --event-pr <N> [--event "<what happened>"] [--json]
//     exit 0 = record / no-record, exit 3 = foreign (prints the ignore line unless --json).
//
// Zero dependencies (Node >= 18).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The PR number a `pr:` value names: a URL ending /pull/<n>, `#<n>`, or a bare number. Else null.
export function prNumber(prField) {
  const v = String(prField ?? "").trim().replace(/^["']|["']$/g, "");
  const m = v.match(/\/pull\/(\d+)\b/) || v.match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Pure decision. `recordState` is the state (OPEN/CLOSED/MERGED) of the PR `prField` names.
export function prOfRecord({ prField, recordState, eventPr }) {
  const record = prNumber(prField);
  if (record === null || String(recordState).toUpperCase() !== "OPEN") return { verdict: "no-record", record: null };
  if (Number(eventPr) === record) return { verdict: "record", record };
  return { verdict: "foreign", record };
}

export function ignoreLine({ event, eventPr, id, record }) {
  const what = eventPr ? `${event} on PR #${eventPr}` : event;
  return `${what} ignored: ${id}'s PR of record is #${record} (open)`;
}

// The `pr:` value of a task file's frontmatter ("" when absent).
export function readPrField(src) {
  const end = src.indexOf("\n---", 3);
  const m = (end === -1 ? src : src.slice(0, end)).match(/^pr:[ \t]*(.*)$/m);
  return m ? m[1].trim() : "";
}

// I/O, injectable for tests: the task file as it is on origin/main, and a PR's state.
export const gitIo = {
  readMainTask(id) {
    const files = execFileSync("git", ["grep", "-l", "-e", `^id: "${id}"`, "origin/main", "--", ".flow/tasks/"], { encoding: "utf8" })
      .split("\n").filter(Boolean);
    if (!files.length) return "";
    return execFileSync("git", ["show", files[0]], { encoding: "utf8" });
  },
  prState(n) {
    return execFileSync("gh", ["pr", "view", String(n), "--json", "state", "--jq", ".state"], { encoding: "utf8" }).trim();
  },
};

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    if (k === "json") out.json = true; else out[k] = argv[++i];
  }
  return out;
}

// The CLI as a function: { code, stdout }. Any I/O failure degrades to no-record (today's
// behaviour) with a warning — a guard that cannot read must not stop the state machine.
export function main(argv, io = gitIo) {
  const f = parseFlags(argv);
  if (!f.id) return { code: 0, stdout: "" };
  let verdict = { verdict: "no-record", record: null };
  try {
    const prField = readPrField(io.readMainTask(f.id));
    const n = prNumber(prField);
    if (n !== null) verdict = prOfRecord({ prField, recordState: io.prState(n), eventPr: f["event-pr"] });
  } catch (e) {
    process.stderr.write(`::warning::pr-of-record: could not read ${f.id}'s PR of record (${String(e.message).split("\n")[0]}) — treating as none.\n`);
  }
  if (f.json) return { code: 0, stdout: JSON.stringify(verdict) + "\n" };
  if (verdict.verdict !== "foreign") return { code: 0, stdout: "" };
  const line = ignoreLine({ event: f.event || "event", eventPr: f["event-pr"] && Number(f["event-pr"]), id: f.id, record: verdict.record });
  return { code: 3, stdout: line + "\n" };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const r = main(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
