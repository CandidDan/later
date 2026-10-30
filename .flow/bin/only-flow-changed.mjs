#!/usr/bin/env node
// only-flow-changed.mjs — decide whether a deploy can be skipped because only Flow's own files
// changed. Zero dependencies, Node >= 18, host-agnostic.
//
//   node .flow/bin/only-flow-changed.mjs [--base <sha>] [--] [extra paths…]
//     exit 0  -> skip:  every change between <base> and HEAD inside the watched scope is Flow-only
//     exit 1  -> build: anything else, or any doubt
//
// Both Vercel's "Ignored Build Step" and Netlify's `ignore` hook treat exit 0 as "skip", so the
// hook line needs no wrapper. Wiring is the adopter's; paths are relative to the host's root
// directory (a nested app writes `node ../.flow/bin/only-flow-changed.mjs`):
//
//   Vercel   vercel.json    { "ignoreCommand": "node .flow/bin/only-flow-changed.mjs" }
//   Netlify  netlify.toml   [build]
//                             ignore = "node .flow/bin/only-flow-changed.mjs"
//
// Base: --base, else $VERCEL_GIT_PREVIOUS_SHA, else $CACHED_COMMIT_REF (Netlify), else HEAD^.
// Watched scope: the cwd, plus each extra path (resolved from the cwd, e.g. ../supabase/functions).
// Flow-only paths: .flow/, changes/ and .github/, resolved from the repository top, not the cwd.
//
// The one invariant: WHEN UNSURE, BUILD. A missing base (shallow clone), a git error, a cwd outside
// a work tree, a malformed argument or a thrown exception all exit 1. No error path exits 0.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FLOW_PATHS = [".flow/", "changes/", ".github/"];

class Doubt extends Error {}

export function parseArgs(argv) {
  let base = "";
  const extra = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) { extra.push(a); continue; }
    if (a === "--") { rest = true; continue; }
    if (a === "--base") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) throw new Doubt("--base needs a commit");
      base = v;
    } else if (a.startsWith("--base=")) {
      base = a.slice(7);
      if (!base || base.startsWith("-")) throw new Doubt("--base needs a commit");
    } else if (a.startsWith("-")) {
      throw new Doubt(`unknown flag ${a}`);
    } else extra.push(a);
  }
  for (const p of extra) if (!p || p.startsWith(":")) throw new Doubt(`bad path ${JSON.stringify(p)}`);
  return { base, extra };
}

export function pickBase({ base }, env) {
  if (base) return { sha: base, source: "--base" };
  if (env.VERCEL_GIT_PREVIOUS_SHA) return { sha: env.VERCEL_GIT_PREVIOUS_SHA, source: "VERCEL_GIT_PREVIOUS_SHA" };
  if (env.CACHED_COMMIT_REF) return { sha: env.CACHED_COMMIT_REF, source: "CACHED_COMMIT_REF" };
  return { sha: "HEAD^", source: "HEAD^" };
}

const defaultGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const lines = (s) => s.split("\n").filter(Boolean);

// Returns { skip: boolean, line: string }. Anything unexpected -> build.
export function decide({ argv = [], env = process.env, cwd = process.cwd(), git = defaultGit } = {}) {
  try {
    const args = parseArgs(argv);
    try { git(["rev-parse", "--is-inside-work-tree"], cwd); }
    catch { return build("not inside a git work tree"); }
    const { sha, source } = pickBase(args, env);
    if (sha.startsWith("-")) return build(`malformed base ${JSON.stringify(sha)}`);
    try { git(["rev-parse", "-q", "--verify", `${sha}^{commit}`], cwd); }
    catch {
      return build(source === "HEAD^"
        ? "no parent commit to compare against"
        : `base ${sha.slice(0, 7)} not in checkout (shallow clone)`);
    }
    const scope = [".", ...args.extra];
    // `--no-renames` (flow-0181), so a rename always lists its source and its destination, as every
    // other guard's changed-path diff does. The decision diff below did not depend on it: git applies
    // the `:(exclude)` pathspecs before it pairs renames, so `git mv src/x.mjs .flow/x.mjs` already
    // showed `src/x.mjs` as deleted and built. What it changes is the count in the skip line.
    const inScope = lines(git(["diff", "--name-only", "--no-renames", sha, "HEAD", "--", ...scope], cwd));
    const other = lines(git(["diff", "--name-only", "--no-renames", sha, "HEAD", "--", ...scope,
      ...FLOW_PATHS.map((p) => `:(top,exclude)${p}`)], cwd));
    if (other.length) return build(`${other.length} file${other.length === 1 ? "" : "s"} changed outside ${FLOW_PATHS.join(" ")}`);
    return {
      skip: true,
      line: `only-flow-changed: skip — ${inScope.length} files changed, all under ${FLOW_PATHS.join(" ")}`,
    };
  } catch (e) {
    return build(e instanceof Doubt ? e.message : `error: ${e?.message ?? e}`);
  }
}

function build(why) {
  return { skip: false, line: `only-flow-changed: build — ${why}` };
}

export function runCli(argv, { env = process.env, cwd = process.cwd(), git, out = (s) => console.log(s) } = {}) {
  const r = decide({ argv, env, cwd, git });
  out(r.line);
  return r.skip ? 0 : 1;
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
  process.exit(code);
}
