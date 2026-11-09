#!/usr/bin/env node
// deployable-sha.mjs — given the commit that passed the gate, name the commit a host actually
// built, and only when it is the same code. Zero dependencies, Node >= 18, host-agnostic. flow-0210.
//
//   node .flow/bin/deployable-sha.mjs --head <sha> [--max 20]
//     exit 0 -> stdout is one full sha: the release target
//     exit 1 -> stdout is empty, stderr says why: do not release
//
// Why it exists. After every merge Flow writes a task-state commit to `main` that changes only
// `.flow/` files, and `only-flow-changed.mjs` tells the host to skip building it. So the newest
// commit on `main` usually passed the gate but was never built, and the commit before it was built
// but is not the newest gated one. A release that requires "gated commit == built commit" can then
// never release (TanPlan, 2026-11-03, issue #286). This is the other half of the deploy skip.
//
// What it does. Walks back from <head> along FIRST parents, at most --max commits counting <head>,
// to the nearest commit whose own change (against its first parent) is not Flow-only. That is the
// commit a host built. Every commit stepped over changed only Flow paths, so the found commit runs
// the same code as <head>. "Flow-only" is `only-flow-changed.mjs`'s own test, imported, so this
// steps over exactly the commits the deploy hook skips. An empty change counts as Flow-only, as the
// hook skips it too.
//
// The one invariant: WHEN UNSURE, REFUSE. No commit found within --max, a git error, a shallow
// clone that ends before the answer, a root commit reached while stepping, a malformed argument or
// a thrown exception all exit 1 with nothing on stdout. No error path exits 0.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOW_PATHS, isFlowOnlyPath } from "./only-flow-changed.mjs";

export { FLOW_PATHS };
export const DEFAULT_MAX = 20;
export const MAX_CEILING = 1000;

class Doubt extends Error {}

export function parseArgs(argv) {
  let head = "";
  let max = DEFAULT_MAX;
  const value = (flag, v) => {
    if (v === undefined || v === "" || v.startsWith("-")) throw new Doubt(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let flag = a, v;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { flag = a.slice(0, eq); v = a.slice(eq + 1); }
    if (flag === "--head") head = value("--head", v ?? argv[++i]);
    else if (flag === "--max") {
      const raw = value("--max", v ?? argv[++i]);
      if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_CEILING) {
        throw new Doubt(`--max must be a whole number from 1 to ${MAX_CEILING}, got ${JSON.stringify(raw)}`);
      }
      max = Number(raw);
    } else throw new Doubt(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!head) throw new Doubt("--head <sha> is required");
  return { head, max };
}

const defaultGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const nul = (s) => String(s).split("\0").filter(Boolean);

// Returns { sha, why }: `sha` is set only when the answer is certain.
export function findDeployable({ argv = [], cwd = process.cwd(), git = defaultGit } = {}) {
  try {
    const { head, max } = parseArgs(argv);
    let sha;
    try { sha = git(["rev-parse", "-q", "--verify", `${head}^{commit}`], cwd).trim(); }
    catch { return refuse(`${JSON.stringify(head)} is not a commit in this clone`); }
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return refuse(`git resolved ${JSON.stringify(head)} to ${JSON.stringify(sha)}`);
    const shallow = git(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true";
    const stepped = [];
    for (let n = 0; n < max; n++) {
      const parents = git(["rev-list", "--parents", "-n", "1", sha], cwd).trim().split(/\s+/).slice(1);
      if (!parents.length) {
        // A shallow clone's boundary commit looks parentless, so its "change" is the whole tree.
        // A true root commit has no earlier build to fall back to. Neither is a certain answer.
        return refuse(shallow
          ? `reached ${sha.slice(0, 7)}, where this shallow clone's history ends; fetch more history`
          : `reached the root commit ${sha.slice(0, 7)} without finding a built commit`);
      }
      const changed = nul(git(["diff", "--name-only", "--no-renames", "-z", parents[0], sha], cwd));
      if (!changed.every(isFlowOnlyPath)) {
        return { sha, why: stepped.length
          ? `stepped over ${stepped.length} Flow-only commit(s) from ${stepped[0].slice(0, 7)}`
          : "the head commit is itself a code commit" };
      }
      stepped.push(sha);
      sha = parents[0];
    }
    return refuse(`the last ${max} commit(s) from ${head} changed only ${FLOW_PATHS.join(" ")}; ` +
      `no built commit within --max ${max}`);
  } catch (e) {
    return refuse(e instanceof Doubt ? e.message : `error: ${e?.message ?? e}`);
  }
}

function refuse(why) {
  return { sha: "", why };
}

export function runCli(argv, { cwd = process.cwd(), git, out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s) } = {}) {
  const r = findDeployable({ argv, cwd, git });
  if (!r.sha) {
    err(`deployable-sha: refuse — ${r.why}\n`);
    return 1;
  }
  out(`${r.sha}\n`);
  err(`deployable-sha: ${r.why}\n`);
  return 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (isMain) {
  let code = 1;
  try { code = runCli(process.argv.slice(2)); } catch { code = 1; }
  process.exitCode = code;
}
