#!/usr/bin/env node
// flow-open-pr.mjs — decide whether a pushed worker branch should get a PR opened for it.
//
// Autonomous workers reliably do the whole loop — claim, branch, build, gate, push — then
// end their turn WITHOUT running `gh pr create`, ending as a "success" while believing they
// are done. The task is left `in_progress` with a pushed branch and no PR: it can't be
// re-picked, and a human has to open the PR by hand (observed twice on CAN-43). Hardening
// the prompt only changes the odds; PR creation is a deterministic, mechanical step, so it
// should not depend on the model's diligence. A workflow opens the PR on branch push — the
// same principle Flow already uses for flow-status/flow-done owning the state transitions.
//
// This module is the pure decision; the git/gh I/O (counting commits ahead, listing open
// PRs, calling `gh pr create`) is a thin shell in the workflow around `decideOpenPr`.
//
//   node .flow/bin/flow-open-pr.mjs --branch flow/CAN-50-x --base main --ahead 3 --has-open-pr 0
//     -> prints {"id":"CAN-50","title":"[CAN-50] …","head":"flow/CAN-50-x","base":"main"}
//        (or nothing, when no PR should be opened)
//
// Zero dependencies (Node >= 18).

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
// The id shape Flow uses — letter-led prefix, dash, numeric suffix (e.g. CAN-50). Self-
// contained on purpose: every Flow helper re-derives this tiny parser rather than coupling
// to a sibling, so each merges and back-ports independently (the pick-task / flow-doctor /
// touches-guard house style). Project-agnostic on the prefix.
const ID = "[A-Za-z][A-Za-z0-9]*-\\d{1,4}";

// The id carried by a `flow/<id>-<slug>` worker branch (or null). The branch is the only id
// source at open time — the PR title that CAN-52 also reads does not exist yet.
export function idFromBranch(branch) {
  if (!branch) return null;
  const m = String(branch).match(new RegExp(`^flow/(${ID})(?:-|$)`));
  return m ? m[1] : null;
}

// Pure decision. Returns the PR to open as { id, title, head, base }, or null to do nothing.
// Opens a PR only when ALL hold: the branch is a worker branch carrying a parseable id, it is
// not the base branch, it is ahead of base (has commits to propose), and no open PR exists
// for it already. Every "no" path returns null so the workflow no-ops rather than opening a
// malformed or duplicate PR.
export function decideOpenPr({ branch, baseBranch = "main", hasOpenPr, aheadOfBase, taskTitle }) {
  if (!branch || branch === baseBranch) return null;   // never a PR for the base branch
  if (hasOpenPr) return null;                           // idempotent — re-pushes don't dup
  if (!aheadOfBase) return null;                        // nothing to propose
  const id = idFromBranch(branch);
  if (!id) return null;                                 // unparseable -> no malformed PR
  const title = taskTitle ? `[${id}] ${taskTitle}` : `[${id}]`;
  return { id, title, head: branch, base: baseBranch };
}

// Thin file read: the title line of the task whose frontmatter id matches. Used by the CLI to
// derive the `[<id>] <title>` PR title from the store. Returns "" when no task file matches.
export function readTaskTitle(tasksDir, id) {
  for (const name of readdirSync(tasksDir)) {
    if (!name.endsWith(".md") || name === "_TEMPLATE.md") continue;
    const src = readFileSync(join(tasksDir, name), "utf8");
    const idM = src.match(/^id:\s*"?([^"\n]+)"?/m);
    if (!idM || idM[1].trim() !== id) continue;
    const titleM = src.match(/^title:\s*"?(.*?)"?\s*$/m);
    return titleM ? titleM[1].trim() : "";
  }
  return "";
}

// ── CLI ── thin shell: parse flags, read the title from the store, print the decision (JSON)
// or nothing. The workflow supplies `--ahead` (git rev-list count) and `--has-open-pr`
// (gh pr list count); this stays I/O-free and deterministic. Always exits 0.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (__isMain) {
  const flags = parseFlags(process.argv.slice(2));
  const branch = flags.branch;
  const baseBranch = flags.base || "main";
  const aheadOfBase = Number(flags.ahead || 0) > 0;
  const hasOpenPr = Number(flags["has-open-pr"] || 0) > 0;

  const flowDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const id = idFromBranch(branch);
  const taskTitle = id ? readTaskTitle(join(flowDir, "tasks"), id) : "";

  const decision = decideOpenPr({ branch, baseBranch, hasOpenPr, aheadOfBase, taskTitle });
  if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(0);
}
