#!/usr/bin/env node
// stamp-intents.mjs — write an intent's `approved_by` / `approved_at` from the merge that approved it.
//
// ADR-0007 decision 2: the MERGE is the approval event, and these two fields are its projection.
// CI writes them; nobody types them. The first real approval (CandidDan/inflight PR #37) showed
// both halves of why: an agent hand-filled them before the merge happened, dated by its own
// calendar, and code-review rightly failed it; reverted to empty, security rightly flagged an
// approved intent that only git merge metadata could attribute. This helper closes that gap.
// `_flow-done.yml` runs it on every merge into `main` (ADR-0007, slice 4).
//
//   node .flow/bin/stamp-intents.mjs --base <sha> --head <sha> --merged-by <login> --merged-at <iso>
//
// `--base` is the merge commit's FIRST PARENT (main before the merge) and `--head` the merge commit.
// The changed set is `git diff base head`; whether an intent was ALREADY approved is read on base.
// The text stamped is the file as it is in the working tree — on the runner that is the tip of
// `main`, which contains the merge. Reading the tip rather than `--head` is deliberate: the push
// retry in `_flow-done.yml` re-runs this against a NEWER tip, and stamping the merge commit's copy
// over it would erase whatever landed in between.
//
// Prints one line per stamped file. Exits 0 when there is nothing to stamp, 1 on any error — a
// stamp silently dropped is the failure this exists to prevent, so nothing here is swallowed.
//
// Zero dependencies (Node >= 18).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync as __realpathSync, writeFileSync } from "node:fs";
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
const STAMPED_FIELDS = ["approved_by", "approved_at"];

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

/**
 * Set `approved_by` / `approved_at` in an intent's text, changing those two values and no other
 * byte. Quoting style is kept (a bare or empty value is written double-quoted, as the template
 * has it). A field the file lacks is added just before the closing `---`, in the file's line ending.
 */
export function stampText(text, mergedBy, mergedAt) {
  const lines = splitLines(text);
  const fm = frontmatter(lines);
  if (!fm) throw new Error("stamp-intents: no frontmatter to stamp");
  const values = { approved_by: mergedBy, approved_at: mergedAt };
  const missing = [];
  for (const key of STAMPED_FIELDS) {
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

/**
 * The pure core. For each changed intent whose status is `approved` — and was NOT already
 * `approved` before this merge — return its text stamped with the merge's values. Overwrites any
 * value already there: the merge is the only source, so a hand-typed value never survives.
 *
 *   changed  — repo paths the merged PR changed
 *   read     — path -> the file's text after the merge (null when it does not exist)
 *   readBase — path -> the file's text before the merge (null when it did not exist); optional
 *   returns  — [{ path, text }] for every file whose text this changes
 */
export function stampIntents({ changed, read, readBase = () => null, mergedBy, mergedAt }) {
  validateMerge(mergedBy, mergedAt);
  const out = [];
  for (const path of [...new Set(changed || [])].sort()) {
    if (!isIntentPath(path)) continue;
    const text = read(path);
    if (typeof text !== "string" || intentStatus(text) !== "approved") continue;
    // Only the merge that MADE it approved stamps it; a later edit to an approved intent is not
    // an approval, and restamping would move the record to whoever merged the edit.
    if (intentStatus(readBase(path)) === "approved") continue;
    const stamped = stampText(text, mergedBy, mergedAt);
    if (stamped !== text) out.push({ path, text: stamped });
  }
  return out;
}

const FLAGS = { "--base": "base", "--head": "head", "--merged-by": "mergedBy", "--merged-at": "mergedAt" };

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
  return args;
}

/**
 * The CLI shell: diff, read, stamp, write. Returns the exit code; `cwd`, `out` and `err` are
 * injectable so the tests drive it in a throwaway repo without spawning.
 */
export function runStampCli(argv, { cwd = process.cwd(), out = process.stdout, err = process.stderr } = {}) {
  try {
    const { base, head, mergedBy, mergedAt } = parseArgs(argv);
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
    const stamped = stampIntents({ changed, read, readBase, mergedBy, mergedAt });
    for (const { path, text } of stamped) {
      writeFileSync(join(cwd, path), text);
      out.write(`stamped ${path}: approved_by=${mergedBy} approved_at=${mergedAt}\n`);
    }
    if (!stamped.length) out.write("stamp-intents: no intent approved by this merge — nothing to stamp\n");
    return 0;
  } catch (e) {
    err.write(`${e.stderr ? String(e.stderr).trim() + "\n" : ""}${e.message}\n`);
    return 1;
  }
}

if (__isMain) process.exit(runStampCli(process.argv.slice(2)));
