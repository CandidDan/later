#!/usr/bin/env node
// flow-recover.mjs — self-heal tasks stranded `in_progress` with no PR.
//
// CAN-50 makes a worker stopping short of `gh pr create` less likely by opening the PR on
// branch push. But prevention can never be total: a process can die at any point — crash,
// timeout, network — between the push and the PR. Today that leaves a task `in_progress`
// with no PR forever: it can't be re-picked (the claim is taken) and nothing resolves it
// until a human notices. That single point of manual rescue is the exact thing the loop is
// meant to remove. A stranded task is a precisely detectable state, so it can be precisely
// healed: this is the recovery half (CAN-50 is prevention).
//
// This module is the pure classifier; the git/gh I/O (does the branch exist, is it ahead of
// base, is there an open PR, how old is it) is a thin shell in the workflow around
// `classifyStranded`. Recovery lives in its OWN script — deliberately NOT in flow-doctor.mjs.
//
//   node .flow/bin/flow-recover.mjs classify --status in_progress \
//        --branch-exists 1 --ahead 1 --has-open-pr 0 --age 90 --threshold 75   -> "reopen-pr"
//   node .flow/bin/flow-recover.mjs classify --status in_progress \
//        --has-open-pr 1 --open-pr-ready 1 --age 90   -> "promote-in-review"
//   node .flow/bin/flow-recover.mjs list-in-progress    # prints "<id>\t<started>\t<branch>" per task
//   node .flow/bin/flow-recover.mjs branch-candidates CAN-51 claude/foo-x   # ls-remote patterns
//   gh pr list --state open --json title | node .flow/bin/flow-recover.mjs count-task-prs CAN-51
//   gh pr list --state open --json number,title,headRefName,isDraft,url \
//     | node .flow/bin/flow-recover.mjs ready-pr CAN-51 <branch>   # "<number>\t<url>", non-draft
//   node .flow/bin/flow-recover.mjs reset CAN-51        # prints the board-edits JSON to reset it
//   node .flow/bin/flow-recover.mjs promote CAN-51 <pr-url> <branch>   # the in_review board edit
//
// Zero dependencies (Node >= 18).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { idFromTitle } from "./parse-task-id.mjs";


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
// Conservative default: don't rescue a task until it has gone this long without resolving to
// a PR. Long enough that a worker mid-loop (build + gate can run many minutes) is never cut
// off; short enough that a genuinely dead session self-heals within the hour. Tune freely.
export const DEFAULT_THRESHOLD_MINUTES = 75;

// Pure classifier. Given a task and the observed git/gh facts, return exactly one of:
//   "ok"                — leave it alone (not in_progress, a draft PR is open, or too young)
//   "reopen-pr"         — work was pushed (branch exists, ahead of base) but no PR opened
//   "reset-to-ready"    — no branch / no commits to recover; clear the claim so it's re-pickable
//   "promote-in-review" — the PR is open AND out of draft, but the task never left in_progress
// Conservative by construction: only `in_progress` is ever swept, an open PR's *code* is never
// disturbed, and nothing happens before the staleness threshold.
export function classifyStranded(task, state, thresholdMinutes = DEFAULT_THRESHOLD_MINUTES) {
  const {
    branchExists = false, hasOpenPr = false, aheadOfBase = false, ageMinutes = 0,
    prStateKnown = true, openPrReady = false,
  } = state || {};
  if (!task || task.status !== "in_progress") return "ok"; // only in_progress is swept
  if (hasOpenPr) {
    // An open PR still means "progressing", and the sweep never touches the PR itself. But
    // `in_progress` + an open PR that is NOT a draft is a state the event stream cannot leave
    // (flow-0104/#91): since flow-0039 the task reaches `in_review` on `ready_for_review`, and
    // that event cannot fire again on a PR that is already out of draft. A task hand-returned to
    // `ready` and re-claimed while its PR was non-draft therefore stays `in_progress` for good,
    // and the board is wrong about what is in flight. The store is what gets corrected here.
    //
    // The same age and threshold as every other outcome, for the same reason: a worker who is
    // still pushing to a non-draft PR (one opened with `gh pr create`, no --draft) must never be
    // flipped mid-work. An unknown PR state never promotes — if we could not read whether the PR
    // is a draft, `openPrReady` arrives false and this is `ok`, exactly as before.
    if (prStateKnown && openPrReady && ageMinutes >= thresholdMinutes) return "promote-in-review";
    return "ok";
  }
  // "We could not find a PR" and "we could not ASK about PRs" are different facts, and only the
  // first is evidence. `gh pr list` failing — a 5xx, a rate limit, an expired token — used to
  // reduce to the same `0` as a genuine absence, and with the branch glob also missing that gave
  // hasOpenPr=false on a task whose PR was open and fine. Past the threshold the sweep then
  // cleared a live claim because GitHub had a bad minute. A destructive action must never be
  // taken on an unknown, so an unknown is not a quiet default here: the caller states it.
  if (!prStateKnown) return "ok";
  if (ageMinutes < thresholdMinutes) return "ok";         // no premature rescue
  if (branchExists && aheadOfBase) return "reopen-pr";    // pushed work, PR just never opened
  return "reset-to-ready";                                // nothing to recover -> re-claimable
}

// ── Finding the work: the task's own fields first, the branch convention second ──────────
//
// Recovery used to discover a stranded task's branch ONLY by the `flow/<id>-…` convention
// glob. That convention is not what workers actually produce: a cloud session is forced onto
// a platform-assigned branch (`claude/ecstatic-goodall-…`), and canonical's own store records
// exactly that — `flow-0001` carries `branch: "claude/next-tasks-ahnx30"`. So the glob matched
// nothing for essentially every real task, and the sweep saw `branchExists=false, ahead=0`.
//
// That is not a missed rescue, it is an active hazard. With no branch found the shell also had
// nothing to ask `gh pr list --head` about, so it reported `hasOpenPr=false` — and a task with
// a live PR and a full branch of work classified `reset-to-ready`, clearing the claim out from
// under it. The fix is the one parse-task-id.mjs already exists for, and that touches-guard
// already uses for the identical reason: read the task's recorded `branch`, and fall back to
// the `[<id>] …` PR title. Same two sources, same precedence, one shared parser.

// The ls-remote patterns to try for a task's branch, in precedence order: the branch the store
// recorded at claim time (authoritative — the worker wrote it), then the `flow/<id>-…`
// convention (still correct for workers that do follow it). Deduped, and empty/blank declared
// values are dropped so the caller never runs `git ls-remote --heads origin ""` — which matches
// EVERY head and would hand recovery an unrelated branch.
export function recoveryBranchCandidates(id, declaredBranch = "") {
  const declared = String(declaredBranch || "").trim();
  const convention = `flow/${id}-*`;
  // A declared branch must look like a ref, not a glob or an option: it reaches `git ls-remote`
  // as an argument. Anything else falls through to the convention rather than being passed on.
  const usable = declared && !declared.startsWith("-") && /^[A-Za-z0-9._\/-]+$/.test(declared);
  return usable && declared !== convention ? [declared, convention] : [convention];
}

// Does this open PR's title belong to this task? The Flow PR convention is `[<id>] <title>`,
// which is the same leading-bracket form parse-task-id resolves — so an id mentioned in the
// middle of a title deliberately does NOT count. This is the second, branch-independent way to
// answer "is this task actually progressing?", and it is what stops a live PR from being read
// as an abandoned claim when the branch cannot be found.
export function isTaskPrTitle(title, id) {
  return !!id && idFromTitle(title) === id;
}

// The board-edit that resets a stranded task so it can be claimed again. Mirrors the
// close-unmerged reset in flow-status.yml exactly: clear owner/branch/pr and go back to ready.
// `started` is intentionally left as-is — apply-board-edits.mjs (the sanctioned writer, which
// this task calls but must not modify) only patches status/priority/owner/branch/pr, and a
// stale `started` on a ready task is harmless (flow-doctor keys re-claimability off `owner`,
// which we DO clear). Applied via apply-board-edits.mjs as a commit to main — never hand-edited.
export function buildResetEdit(id) {
  return { id, status: "ready", owner: "", branch: "", pr: "" };
}

// ── The non-draft open PR: the one fact `promote-in-review` turns on ─────────────────────
//
// Reads `gh pr list --state open --json number,title,headRefName,isDraft,url` output and returns
// the first PR that belongs to this task AND is out of draft, as `{ number, url }` — or null.
//
// "Belongs to this task" is the sweep's existing pair of sources, unchanged and in the same
// precedence: the `[<id>] …` PR title, or the PR's head being the task's branch. Both are served
// from the ONE `gh pr list` call the sweep already makes per task (it gained three fields), so
// this costs no extra API request — and the title rule stays in ONE place rather than being
// re-expressed as a jq filter in the workflow, which is the drift this helper exists to avoid.
//
// Null is returned for anything doubtful: a draft PR, a PR whose `isDraft` is absent or
// non-boolean, a title and head that both miss, unparseable input. Every one of those reaches
// classifyStranded as `openPrReady=false`, which is `ok` — the sweep's existing behaviour. The
// asymmetry is deliberate: "I could not tell" must look like "do not promote".
export function readyOpenPr(prs, id, branch = "") {
  if (!Array.isArray(prs)) return null;
  const head = String(branch || "").trim();
  for (const pr of prs) {
    if (!pr || typeof pr !== "object") continue;
    const mine = isTaskPrTitle(pr.title, id) ||
      (!!head && typeof pr.headRefName === "string" && pr.headRefName.trim() === head);
    if (!mine) continue;
    if (pr.isDraft !== false) continue;          // true, undefined and non-boolean all mean "no"
    // Only a PR from a branch IN THIS REPO may promote. Matching is by title or branch name,
    // and on a public repo anyone can fork and open a non-draft PR titled `[<id>] …`; letting
    // that write `in_review` and its url onto `main` would let a stranger hijack which PR the
    // store treats as the task's implementation. Workers push to this repo, never a fork, and
    // anyone who can push here is already trusted. Absent or non-boolean is an unknown, and an
    // unknown never promotes (the same rule as isDraft).
    if (pr.isCrossRepository !== false) continue;
    const number = Number(pr.number);
    const url = typeof pr.url === "string" ? pr.url.trim() : "";
    if (!Number.isInteger(number) || number <= 0) continue;
    if (!/^https:\/\/[^\s"]+$/.test(url)) continue;   // it is written into a task file; see below
    return { number, url };
  }
  return null;
}

// The board-edit that moves a stuck `in_progress` task to `in_review`, recording the PR it was
// already waiting on. The counterpart of buildResetEdit, and applied the same way: through
// apply-board-edits.mjs, as a commit to main, never a hand-edit.
//
// `pr` and `branch` are OMITTED when blank rather than written as "": apply-board-edits patches
// exactly the fields present, so an empty string would clobber a branch the store already knows
// (the title match finds a PR even when the branch glob missed, which is precisely the case where
// `branch` here is empty). Both are also shape-checked, because apply-board-edits rejects a value
// containing a quote or newline as a *problem* and exits non-zero — which would fail the whole
// sweep over one malformed field instead of leaving one task uncorrected.
export function buildPromoteEdit(id, prUrl = "", branch = "") {
  const edit = { id, status: "in_review" };
  const pr = String(prUrl || "").trim();
  if (/^https:\/\/[^\s"]+$/.test(pr)) edit.pr = pr;
  const b = String(branch || "").trim();
  if (/^[A-Za-z0-9._\/-]+$/.test(b)) edit.branch = b;
  return edit;
}

// Whole minutes elapsed between a timestamp (ISO datetime, or a date-only `started` like
// "2026-06-18") and `now`. Negative clamps to 0. Returns null for an unparseable/empty value
// so the caller can decide (a task with no `started` shouldn't be aged out on a bad parse).
//
// A date-only value is anchored to the END of that day (23:59:59.999Z), NOT its midnight.
// `Date.parse("2026-06-18")` gives 00:00Z, which makes a task claimed at 09:23Z read as 563
// minutes old at the instant of the claim — already past the 75-minute strand threshold. The
// sweep then resets a live claim back to `ready` about a minute after it is taken, the next
// queue-runner re-picks the same task from zero, and no run's work carries forward. Anchoring
// to end-of-day errs the only safe way for a destructive sweep: it can delay a genuine
// recovery by up to a day, but it can never cancel a claim that is still being worked.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function minutesSince(when, now = Date.now()) {
  if (!when) return null;
  const t = Date.parse(DATE_ONLY.test(when) ? `${when}T23:59:59.999Z` : when);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60000));
}

// Parse the few frontmatter fields the sweep needs from a task file's text.
function parseTask(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].split("#")[0].trim().replace(/^"(.*)"$/, "$1") : "";
  };
  const id = get("id");
  if (!id) return null;
  return { id, status: get("status"), started: get("started"), branch: get("branch") };
}

// Read every task file in a tasks dir (skips _TEMPLATE.md and non-.md).
export function readTasks(tasksDir) {
  const out = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const t = parseTask(readFileSync(join(tasksDir, name), "utf8"));
    if (t) out.push(t);
  }
  return out;
}

// ── CLI ── seven thin subcommands; the workflow supplies all git/gh facts. Always exits 0.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// ── ONE CLI, two callers ─────────────────────────────────────────────────────────────────
//
// This function is the whole CLI, and it is exported because canonical runs it too. The
// reusable `_flow-recover.yml` invokes `.flow/bin/flow-recover.mjs` in the CONSUMING repo, and
// canonical is one of those — but the template resolves its store from its own realpath, which
// is `project-template/.flow/tasks`, the fixture store. So canonical's `.flow/bin/` holds an
// adapter that supplies its real store location instead.
//
// That adapter used to hand-copy this shell, and the copy went stale exactly as a second
// implementation always does: flow-0104 added `--open-pr-ready`, `ready-pr` and `promote` here,
// the copy grew none of them, and `promote-in-review` was therefore inert in canonical's own
// sweep — silently, because the missing flag arrives as 0 and `ready-pr` prints nothing, which
// are both indistinguishable from "no ready PR". The next subcommand added would have gone the
// same way. Hence one function, parameterised by the only thing that actually differs:
//
//   export function runRecoverCli(argv, { tasksDir, stdin?, out? }): number
//
// `tasksDir` is the store to read; `stdin` and `out` are injectable so a test can drive this
// in-process. The usage line stays on `process.stderr` and is deliberately NOT injectable: it
// is diagnostic, the sweep never reads it, and stdout is the only channel that carries an
// answer. The return value is the exit code, and it is always 0 — a scheduled sweep must
// degrade to a no-op rather than fail the run (see the subcommand notes above for why "could
// not tell" must never look like a finding).
export function runRecoverCli(argv, opts = {}) {
  const { tasksDir } = opts;
  const out = opts.out || process.stdout;
  const readStdin = opts.stdin || (() => {
    try { return readFileSync(0, "utf8"); } catch { return ""; }
  });
  const [cmd, ...rest] = argv;

  if (cmd === "classify") {
    const f = parseFlags(rest);
    const decision = classifyStranded(
      { status: f.status },
      {
        branchExists: Number(f["branch-exists"] || 0) > 0,
        hasOpenPr: Number(f["has-open-pr"] || 0) > 0,
        aheadOfBase: Number(f.ahead || 0) > 0,
        ageMinutes: Number(f.age || 0),
        // Defaults to known, so a caller that never learned to pass it behaves exactly as before.
        prStateKnown: f["pr-state-known"] === undefined || Number(f["pr-state-known"]) > 0,
        // Defaults to 0 — i.e. "not a ready PR" — for the same reason: an older workflow that
        // never passes it gets today's answers, and an unreadable draft state never promotes.
        openPrReady: Number(f["open-pr-ready"] || 0) > 0,
      },
      f.threshold ? Number(f.threshold) : DEFAULT_THRESHOLD_MINUTES,
    );
    out.write(decision + "\n");
  } else if (cmd === "list-in-progress") {
    // Three tab-separated fields. `branch` is the third and may be empty — the shell reads it
    // with a trailing `read -r id started branch`, so an absent value stays an empty string
    // rather than shifting the columns.
    for (const t of readTasks(tasksDir)) {
      if (t.status === "in_progress") {
        out.write(`${t.id}\t${t.started}\t${t.branch}\n`);
      }
    }
  } else if (cmd === "branch-candidates") {
    const [id, declared] = rest;
    if (id) for (const p of recoveryBranchCandidates(id, declared)) out.write(p + "\n");
  } else if (cmd === "count-task-prs") {
    // Reads `gh pr list --json title` output on stdin and prints how many of those PRs belong
    // to this task. Deliberately NOT a jq expression in the workflow: the `[<id>] …` rule is
    // already implemented here, and a second copy in shell is the drift hazard this repo keeps
    // warning about.
    //
    // Unparseable input prints 0 so the sweep cannot crash — but 0 here is NOT a safe default and
    // must not be read as one. A count of 0 feeds `hasOpenPr=false`, which past the threshold is
    // what produces `reset-to-ready`; so "I could not parse the answer" would otherwise become
    // "there is no PR" and clear a live claim. Whether the question was answerable AT ALL is a
    // separate fact the caller must establish and pass as `prStateKnown` — see classifyStranded.
    const id = rest[0];
    let n = 0;
    try {
      const prs = JSON.parse(readStdin() || "[]");
      if (Array.isArray(prs)) n = prs.filter((p) => isTaskPrTitle(p && p.title, id)).length;
    } catch { n = 0; }
    out.write(String(n) + "\n");
  } else if (cmd === "ready-pr") {
    // Same stdin as count-task-prs (one `gh pr list` call, two questions asked of it). Prints
    // "<number>\t<url>" for the task's open non-draft PR, or NOTHING at all — the shell reads an
    // empty result as "no ready PR" and passes --open-pr-ready 0.
    const [id, branch] = rest;
    let prs = [];
    try { prs = JSON.parse(readStdin() || "[]"); } catch { prs = []; }
    const hit = readyOpenPr(prs, id, branch);
    if (hit) out.write(`${hit.number}\t${hit.url}\n`);
  } else if (cmd === "reset") {
    const id = rest[0];
    if (id) out.write(JSON.stringify({ updates: [buildResetEdit(id)] }) + "\n");
  } else if (cmd === "promote") {
    const [id, prUrl, branch] = rest;
    if (id) {
      out.write(JSON.stringify({ updates: [buildPromoteEdit(id, prUrl, branch)] }) + "\n");
    }
  } else {
    process.stderr.write(
      "usage: flow-recover.mjs " +
        "<classify|list-in-progress|branch-candidates|count-task-prs|ready-pr|reset|promote> …\n",
    );
  }
  return 0;
}

if (__isMain) {
  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(runRecoverCli(process.argv.slice(2), { tasksDir: join(flowDir, "tasks") }));
}
