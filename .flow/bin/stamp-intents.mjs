#!/usr/bin/env node
// stamp-intents.mjs — write an intent's approval from the merge that approved it.
//
// ADR-0007 decision 2: the MERGE is the approval event, and an intent's `status: "approved"`,
// `approved_by` and `approved_at` are its projection. CI writes them; nobody types them. The first
// real approval (CandidDan/inflight PR #37) showed why: an agent hand-filled them before the merge
// happened, dated by its own calendar, and code-review rightly failed it. `_flow-done.yml` runs this
// on every merge into `main` (ADR-0007, slice 4).
//
//   node .flow/bin/stamp-intents.mjs --base <sha> --head <sha> --merged-by <login> --merged-at <iso>
//                                    [--repo <owner/name>]
//
// Two passes, in this order (flow-0209):
//
//   1. THE NORMAL PATH. Every intent this merge ADDS — absent on `--base`, present after — gets
//      `status: "approved"` (a `superseded` one keeps its status) and this merge's login and
//      instant, overwriting whatever the PR typed. An intent the merge only EDITS is never stamped
//      here. (flow-0127 stamped an intent only if the PR itself had set `status: "approved"`; every
//      intent is written `proposed`, so it never fired.)
//   2. THE REPAIR. Every intent in the working tree whose `approved_by` is still empty is stamped
//      from the merge of the PR that ADDED that file: git finds the commit that added it, the
//      GitHub API names the PR that commit merged in with, and that PR's `merged_by` / `merged_at`
//      are written. Never the running merge's values. Needs `--repo`; an optional token is read
//      from GH_TOKEN or GITHUB_TOKEN. An intent whose adding PR cannot be identified stays
//      unstamped and the log names it — the next merge tries again, so nothing is lost by waiting.
//
// An intent with a non-empty `approved_by` is never stamped again, by either pass.
//
// `--base` is the merge commit's FIRST PARENT (main before the merge) and `--head` the merge commit.
// The text stamped is the file as it is in the working tree — on the runner that is the tip of
// `main`, which contains the merge. Reading the tip rather than `--head` is deliberate: the push
// retry in `_flow-done.yml` re-runs this against a NEWER tip, and stamping the merge commit's copy
// over it would erase whatever landed in between.
//
// Prints one line per stamped file. Exits 0 when there is nothing to stamp, 1 on any error in the
// normal path — a stamp silently dropped is the failure this exists to prevent. The repair is the
// one exception: a lookup that fails is logged by file and left for the next merge, because one
// unreachable API must not cost the merge its own stamp.
//
// Zero dependencies (Node >= 18).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync as __realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";

// --- main-module detection (do not simplify back to a string compare) -------------------
// See parse-task-id.mjs: through a symlinked path a string compare is false and the CLI block
// silently never runs — exit 0, nothing stamped, nothing to debug.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

export const INTENTS_DIR = ".flow/intents/";

// A GitHub login: alphanumerics and single hyphens, plus the `[bot]` suffix an app merge carries.
// Strict on purpose — the value is written into YAML, so a quote or a newline must never reach it.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
// A full UTC instant to the second, exactly as GitHub reports `merged_at`. Not a date: inflight #37
// showed a bare local date reads as "the future" to a reviewer in UTC.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** True for a path the stamper owns: a direct child of `.flow/intents/`, Markdown, not the template. */
export function isIntentPath(path) {
  if (typeof path !== "string" || !path.startsWith(INTENTS_DIR)) return false;
  const name = path.slice(INTENTS_DIR.length);
  return name.endsWith(".md") && !name.includes("/") && name !== "_TEMPLATE.md";
}

/** Throws unless `mergedBy` is a login and `mergedAt` a real UTC instant like 2026-10-03T07:52:11Z. */
export function validateMerge(mergedBy, mergedAt) {
  if (typeof mergedBy !== "string" || mergedBy === "") {
    throw new Error("stamp-intents: mergedBy is empty — the merge event carries no merger, so there is nothing true to stamp");
  }
  if (!LOGIN_RE.test(mergedBy)) {
    throw new Error(`stamp-intents: mergedBy ${JSON.stringify(mergedBy)} is not a GitHub login`);
  }
  const instant = typeof mergedAt === "string" && INSTANT_RE.test(mergedAt) ? new Date(mergedAt) : null;
  // The round trip rejects a well-shaped impossible instant (2026-02-30T…), which Date would roll over.
  if (!instant || Number.isNaN(instant.getTime()) || instant.toISOString().replace(".000Z", "Z") !== mergedAt) {
    throw new Error(`stamp-intents: mergedAt ${JSON.stringify(mergedAt)} is not a full UTC ISO-8601 instant (e.g. 2026-10-03T07:52:11Z)`);
  }
}

// Split keeping each line's own ending, so a CRLF file is rebuilt byte-for-byte.
const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const bodyOf = (line) => line.replace(/\r?\n$/, "");
const eolOf = (line) => line.slice(bodyOf(line).length);

// The frontmatter's line range: [first field line, closing `---` line), or null when there is none.
function frontmatter(lines) {
  if (!lines.length || bodyOf(lines[0]) !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && bodyOf(l) === "---");
  return close === -1 ? null : { start: 1, close };
}

// One `key: value  # comment` line, split so the value can be swapped and nothing else moves.
// `value` is the raw token (quotes included); `quote` is `"`, `'` or "" (bare or empty).
function parseField(line, key) {
  const body = bodyOf(line);
  const m = body.match(new RegExp(`^(${key}:[ \\t]*)(.*)$`));
  if (!m) return null;
  const [, lead, rest] = m;
  let token = "";
  if (rest.startsWith('"')) {
    const end = rest.slice(1).search(/(?<!\\)"/);
    token = end === -1 ? rest : rest.slice(0, end + 2);
  } else if (rest.startsWith("'")) {
    const end = rest.slice(1).search(/'(?!')/);
    token = end === -1 ? rest : rest.slice(0, end + 2);
  } else {
    token = rest.replace(/[ \t]+#.*$/, "").replace(/[ \t]+$/, "");
  }
  const quote = token[0] === '"' || token[0] === "'" ? token[0] : "";
  return { lead, token, tail: rest.slice(token.length), eol: eolOf(line), quote };
}

const unquote = (token) => {
  if (token.startsWith('"') && token.endsWith('"') && token.length > 1) return token.slice(1, -1);
  if (token.startsWith("'") && token.endsWith("'") && token.length > 1) return token.slice(1, -1).replace(/''/g, "'");
  return token;
};

/** The frontmatter `status` of an intent's text, unquoted, or null when it has none. */
export function intentStatus(text) {
  if (typeof text !== "string") return null;
  const lines = splitLines(text);
  const fm = frontmatter(lines);
  if (!fm) return null;
  for (let i = fm.start; i < fm.close; i++) {
    const f = parseField(lines[i], "status");
    if (f) return unquote(f.token);
  }
  return null;
}

/** The frontmatter `approved_by` of an intent's text, unquoted; "" when empty or absent. */
export function intentApprovedBy(text) {
  if (typeof text !== "string") return "";
  const lines = splitLines(text);
  const fm = frontmatter(lines);
  if (!fm) return "";
  for (let i = fm.start; i < fm.close; i++) {
    const f = parseField(lines[i], "approved_by");
    if (f) return unquote(f.token).trim();
  }
  return "";
}

// Set each `key: value` in the frontmatter, changing those values and no other byte. Quoting style
// is kept (a bare or empty value is written double-quoted, as the template has it). A field the file
// lacks is added just before the closing `---`, in the file's line ending.
function setFields(text, values) {
  const lines = splitLines(text);
  const fm = frontmatter(lines);
  if (!fm) throw new Error("stamp-intents: no frontmatter to stamp");
  const missing = [];
  for (const key of Object.keys(values)) {
    let found = false;
    for (let i = fm.start; i < fm.close; i++) {
      const f = parseField(lines[i], key);
      if (!f) continue;
      const q = f.quote || '"';
      const lead = f.lead.endsWith(":") ? f.lead + " " : f.lead;
      lines[i] = `${lead}${q}${values[key]}${q}${f.tail}${f.eol}`;
      found = true;
      break;
    }
    if (!found) missing.push(key);
  }
  if (missing.length) {
    const eol = eolOf(lines[0]) || "\n";
    lines.splice(fm.close, 0, ...missing.map((k) => `${k}: "${values[k]}"${eol}`));
  }
  return lines.join("");
}

/** Set `approved_by` / `approved_at` only (flow-0127's projection), changing no other byte. */
export function stampText(text, mergedBy, mergedAt) {
  return setFields(text, { approved_by: mergedBy, approved_at: mergedAt });
}

/**
 * The whole approval: `status: "approved"` — unless the intent is `superseded`, which it stays —
 * plus `approved_by` / `approved_at`. Every other byte is kept.
 */
export function approveText(text, mergedBy, mergedAt) {
  const values = intentStatus(text) === "superseded" ? {} : { status: "approved" };
  return setFields(text, { ...values, approved_by: mergedBy, approved_at: mergedAt });
}

/**
 * The normal path, pure. For each intent this merge ADDS (no copy on base), return its text
 * approved with the merge's values. Overwrites any value already there: the merge is the only
 * source, so a hand-typed value never survives. An intent that existed on base — edited, not
 * added — is not stamped; nor is one whose base copy already carries an `approved_by`.
 *
 *   changed  — repo paths the merged PR changed
 *   read     — path -> the file's text after the merge (null when it does not exist)
 *   readBase — path -> the file's text before the merge (null when it did not exist)
 *   returns  — [{ path, text }] for every file whose text this changes
 */
export function stampIntents({ changed, read, readBase = () => null, mergedBy, mergedAt }) {
  validateMerge(mergedBy, mergedAt);
  const out = [];
  for (const path of [...new Set(changed || [])].sort()) {
    if (!isIntentPath(path)) continue;
    const text = read(path);
    if (typeof text !== "string" || !frontmatter(splitLines(text))) continue;
    const base = readBase(path);
    // Only the merge that ADDED it is its approval. A later edit is not one, and restamping
    // would move the record to whoever merged the edit.
    if (typeof base === "string") continue;
    const stamped = approveText(text, mergedBy, mergedAt);
    if (stamped !== text) out.push({ path, text: stamped });
  }
  return out;
}

/**
 * The repair, with its one side effect — the lookup — injected. For every intent in `paths` whose
 * `approved_by` is empty, ask `findAddingMerge(path)` for the merge of the PR that added the file
 * and approve the text with THAT merge's values.
 *
 *   paths            — intent paths currently in the tree
 *   read             — path -> text (null when absent)
 *   findAddingMerge  — async path -> { pr, mergedBy, mergedAt } or null; may throw
 *   returns          — { stamped: [{ path, text, pr, mergedBy, mergedAt }], unresolved: [{ path, reason }] }
 *
 * A null, a throw, or a merge whose values fail validation leaves that intent unstamped and listed
 * in `unresolved` with the reason. Nothing here throws: the caller decides how loud to be.
 */
export async function repairIntents({ paths, read, findAddingMerge }) {
  const stamped = [];
  const unresolved = [];
  for (const path of [...new Set(paths || [])].sort()) {
    if (!isIntentPath(path)) continue;
    const text = read(path);
    if (typeof text !== "string" || !frontmatter(splitLines(text))) continue;
    if (intentApprovedBy(text) !== "") continue;
    let merge;
    try {
      merge = await findAddingMerge(path);
    } catch (e) {
      unresolved.push({ path, reason: e.message });
      continue;
    }
    if (!merge) {
      unresolved.push({ path, reason: "no merged pull request added this file" });
      continue;
    }
    try {
      validateMerge(merge.mergedBy, merge.mergedAt);
    } catch (e) {
      unresolved.push({ path, reason: `PR #${merge.pr}: ${e.message}` });
      continue;
    }
    const next = approveText(text, merge.mergedBy, merge.mergedAt);
    if (next !== text) stamped.push({ path, text: next, ...merge });
  }
  return { stamped, unresolved };
}

// owner/name, the shape `github.repository` has. Strict: it is interpolated into an API URL.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The GitHub side of the repair: the merge of the PR that brought `sha` into `branch`. Asks which
 * PRs the commit is associated with, keeps those merged into `branch`, takes the EARLIEST merge
 * (the one that first brought the commit in), then reads that PR for `merged_by`, which the list
 * does not carry. Returns { pr, mergedBy, mergedAt } or null when no such PR exists; throws on an
 * HTTP error, naming the status.
 */
export async function addingMergeFromGitHub(sha, { repo, token = "", fetchImpl = globalThis.fetch,
  apiUrl = "https://api.github.com", branch = "main" } = {}) {
  if (!REPO_RE.test(repo || "")) throw new Error(`stamp-intents: --repo ${JSON.stringify(repo)} is not owner/name`);
  if (!SHA_RE.test(sha || "")) throw new Error(`stamp-intents: ${JSON.stringify(sha)} is not a commit sha`);
  const get = async (path) => {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${apiUrl}/repos/${repo}${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${path} answered HTTP ${res.status}`);
    return res.json();
  };
  const prs = await get(`/commits/${sha}/pulls`);
  const merged = (Array.isArray(prs) ? prs : [])
    .filter((p) => p && p.merged_at && p.base && p.base.ref === branch)
    .sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)));
  if (!merged.length) return null;
  const pr = await get(`/pulls/${Number(merged[0].number)}`);
  return { pr: pr.number, mergedBy: pr.merged_by && pr.merged_by.login, mergedAt: pr.merged_at };
}

const FLAGS = {
  "--base": "base", "--head": "head", "--merged-by": "mergedBy", "--merged-at": "mergedAt", "--repo": "repo",
};

/** Parse the CLI's flags. Throws on an unknown flag, a missing value, or a value that looks like a flag. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = FLAGS[argv[i]];
    if (!name) throw new Error(`stamp-intents: unknown argument ${JSON.stringify(argv[i])}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`stamp-intents: ${argv[i - 1]} needs a value`);
    args[name] = value;
  }
  for (const flag of ["--base", "--head"]) {
    const v = args[FLAGS[flag]];
    // A leading dash would reach git as an option rather than a revision.
    if (!v || v.startsWith("-")) throw new Error(`stamp-intents: ${flag} <sha> is required`);
  }
  if (args.repo !== undefined && !REPO_RE.test(args.repo)) {
    throw new Error(`stamp-intents: --repo ${JSON.stringify(args.repo)} is not owner/name`);
  }
  return args;
}

/**
 * The CLI shell: diff, read, stamp, write, then repair. Resolves to the exit code. `cwd`, `out`,
 * `err`, `env` and `fetchImpl` are injectable so the tests drive it in a throwaway repo with the
 * GitHub API replaced by a fixture.
 */
export async function runStampCli(argv, {
  cwd = process.cwd(), out = process.stdout, err = process.stderr, env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  let stampedAny = false;
  try {
    const { base, head, mergedBy, mergedAt, repo } = parseArgs(argv);
    validateMerge(mergedBy, mergedAt);
    const git = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const changed = git(["diff", "--name-only", "--no-renames", "-z", base, head, "--", INTENTS_DIR])
      .split("\0").filter(Boolean);
    const read = (path) => {
      const abs = join(cwd, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    const readBase = (path) => {
      try { return git(["show", `${base}:${path}`]); } catch { return null; }
    };
    for (const { path, text } of stampIntents({ changed, read, readBase, mergedBy, mergedAt })) {
      writeFileSync(join(cwd, path), text);
      out.write(`stamped ${path}: approved_by=${mergedBy} approved_at=${mergedAt}\n`);
      stampedAny = true;
    }

    // The repair reads the tree AFTER the normal path wrote it, so an intent this merge added is
    // already stamped and skipped. Its lookups never fail the run (see the header).
    const dir = join(cwd, INTENTS_DIR);
    const paths = existsSync(dir) ? readdirSync(dir).map((n) => INTENTS_DIR + n).filter(isIntentPath) : [];
    const pending = paths.filter((p) => intentApprovedBy(read(p)) === "" && frontmatter(splitLines(read(p) || "")));
    if (pending.length && !repo) {
      out.write(`stamp-intents: repair skipped (no --repo) — still unstamped: ${pending.join(", ")}\n`);
    } else if (pending.length) {
      const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
      const token = env.GH_TOKEN || env.GITHUB_TOKEN || "";
      const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
      const cache = new Map();
      const findAddingMerge = async (path) => {
        // A shallow clone's oldest commit looks like it added every file it holds: refuse to guess.
        if (shallow) throw new Error("the checkout is shallow, so git cannot say which commit added it (git fetch --unshallow)");
        const sha = git(["log", "--diff-filter=A", "--no-renames", "--format=%H", "-1", "HEAD", "--", path]).trim();
        if (!sha) return null;
        if (!cache.has(sha)) cache.set(sha, addingMergeFromGitHub(sha, { repo, token, fetchImpl, apiUrl }));
        return cache.get(sha);
      };
      const { stamped, unresolved } = await repairIntents({ paths: pending, read, findAddingMerge });
      for (const s of stamped) {
        writeFileSync(join(cwd, s.path), s.text);
        out.write(`stamped ${s.path}: approved_by=${s.mergedBy} approved_at=${s.mergedAt} (repair, from PR #${s.pr})\n`);
        stampedAny = true;
      }
      for (const u of unresolved) out.write(`stamp-intents: left unstamped ${u.path}: ${u.reason}\n`);
    }
    if (!stampedAny) out.write("stamp-intents: no intent approved by this merge — nothing to stamp\n");
    return 0;
  } catch (e) {
    err.write(`${e.stderr ? String(e.stderr).trim() + "\n" : ""}${e.message}\n`);
    return 1;
  }
}

if (__isMain) process.exit(await runStampCli(process.argv.slice(2)));
