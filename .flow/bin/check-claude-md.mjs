#!/usr/bin/env node
// check-claude-md.mjs — enforce the CLAUDE.md ceiling against the RESOLVED IMPORT SET.
//
// WHY THIS FILE EXISTS. `CLAUDE.md` auto-loads into every session in every Flow repo, so every
// line in it is always-on context, and the template has always carried a ceiling on it. That
// ceiling was a sentence — nothing measured it, and CandidDan/Nudge sat at 36,338 characters, 45%
// over, with nothing reporting it. Every other number Flow cares about (`coverage_min`) fails the
// gate; this one was advice.
//
// WHY `wc -c CLAUDE.md` IS THE WRONG RULER, which is the part that actually matters. Line 11 of
// the template's own `CLAUDE.md` is `@.flow/PROTOCOL.md` — a Claude Code **import**. Claude Code
// resolves it and loads the target into context at session start, in full. So a repo can HALVE
// `wc -c CLAUDE.md` and INCREASE the context it loads, by moving prose behind an import. Nudge's
// adoption PR does exactly that, honestly and with the arithmetic stated: `CLAUDE.md` drops
// 36,338 -> 25,630 while the session gains the whole 23,753-character protocol. A byte-counting
// check would have called that a 10,708-character improvement. It is a ~13,000 regression.
//
// A check measuring file bytes is therefore defeated on day one by canonical's own template.
// This one measures what a session actually loads: `CLAUDE.md` plus every file reachable from it
// by import, each counted once.
//
// THE NUMBER IS PER-REPO, THE MECHANISM IS NOT. Exactly the `coverage_min` shape. Every Flow repo
// auto-loads a `CLAUDE.md` and suffers the same dilution, so enforcement is shared infra authored
// in canonical. The allowance cannot be shared: a repo carrying generated routing tables needs a
// different one from a repo that does not. So `claude_md_max` is declared per-repo in
// `.flow/config.yml`, and there is no second config idiom.
//
// WHAT THE CEILING IS FOR, stated plainly so a reviewer does not re-frame it. It is NOT context
// pressure. Measured in a live session: `CLAUDE.md` was 14.2k tokens against a 1M window — 1.4%,
// with 75.7% of the window free. Nothing is running out. The cost of a large always-on
// instruction block is that every rule competes with every other rule for ADHERENCE, and that
// does not improve as windows grow.
//
// STILL NO YAML DEPENDENCY. `claude_md_max` is read by the same line scan `source-roots.mjs`
// uses, for the same two reasons: these helpers run in `_flow-gates.yml` with no install step
// before them, and canonical ships as source others copy, so a dependency added here is imposed
// downstream.
//
// THE HOST FILE IS INJECTED, NOT BAKED IN, and that is not a style choice. A pinned invariant of
// this repo (`.flow/bin/protocol-portability.test.mjs`, "nothing in the tooling READS the protocol
// by CLAUDE.md filename") forbids any helper in a shipped `bin/` from naming the host file in
// EXECUTABLE code: the filename is Claude Code's convention, and a helper that opens it by name
// re-binds Flow to one vendor. A comment may name it; code may not. So the entry point arrives as
// `--entry <path>` (or `FLOW_CONTEXT_ENTRY`), supplied by the gate step in `_flow-gates.yml`, and
// this file measures whatever host file it is handed. There is no default and omitting it is a
// usage error, never an empty pass — a default would be the binding wearing a disguise.
//
//   node .flow/bin/check-claude-md.mjs --entry CLAUDE.md           # enforce
//   node .flow/bin/check-claude-md.mjs --entry CLAUDE.md --json    # the same verdict as data
//
// WHAT IS DELIBERATELY ABSENT: no warn-only mode, no second threshold, no per-file ceiling. One
// number, one behaviour, matching `coverage_min`. A warn-only mode is how the sentence this file
// replaces failed in the first place.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code follows imports to a maximum depth of 5 hops. The root `CLAUDE.md` is hop 0, a file
// it imports is hop 1, and an import that would land at hop 6 is NOT loaded by Claude Code — so
// this check does not count it, and says so rather than counting it silently.
export const MAX_IMPORT_DEPTH = 5;

// The config key. Named for what it bounds (the CLAUDE.md context), not for the file it is read
// from, because the thing measured is a set of files and not one.
export const CEILING_KEY = "claude_md_max";

// How the host file reaches this helper. Both forms, because the gate passes the flag and a human
// debugging a repo locally should not have to remember which one.
export const ENTRY_FLAG = "--entry";
export const ENTRY_ENV = "FLOW_CONTEXT_ENTRY";

/** The host file from argv or the environment, or null — never a baked-in default. */
export function resolveEntry(argv = [], env = process.env) {
  const i = argv.indexOf(ENTRY_FLAG);
  if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  const fromEnv = String(env[ENTRY_ENV] ?? "").trim();
  return fromEnv || null;
}

export const USAGE = `usage: check-claude-md.mjs ${ENTRY_FLAG} <host-file> [--json]

The host file is not baked in: its name is one agent vendor's convention, and a helper that
opened it by name would re-bind Flow to that vendor (see protocol-portability). Pass
\`${ENTRY_FLAG} <the host file this repo auto-loads>\`, or set ${ENTRY_ENV}. The gate step in
_flow-gates.yml is where that binding lives.`;

// ─────────────────────────────────────────────────────────────────────────────────────────
// The import parser
// ─────────────────────────────────────────────────────────────────────────────────────────

// An import candidate: `@` then a path that NAMES A FILE — it must carry an extension. The `@`
// must start a line or follow whitespace or an opening bracket, so `you@example.com` and
// `@anthropic-ai/claude-code` are not candidates (the first fails the boundary, the second has no
// extension).
//
// The narrowness is deliberate and it is the safe direction. An unresolvable `@path` is a hard
// FAILURE here (see `resolveImportSet`), so a false positive on prose would fail a repo's gate on
// a sentence, while a false negative merely undercounts. The one thing that must never be missed
// — `@.flow/PROTOCOL.md`, the import the template itself ships — names a file with an extension,
// so it is matched.
const IMPORT_RE = /(^|[\s(\[{])@((?:[.~]{0,2}\/)?[\w.~@+/-]*\.[A-Za-z0-9]+)/gm;

/**
 * The `@`-import paths declared by one file's text, in source order, de-duplicated.
 *
 * TWO EXCLUSIONS, BOTH LOAD-BEARING, and both taken from the template's own text rather than
 * invented here: Claude Code's import parser skips `@paths` inside INLINE BACKTICKS and inside
 * FENCED CODE BLOCKS. That is precisely why the template tells the reader to "Leave it outside
 * backticks and outside code fences". A check that read them as imports would demand a file for
 * every `@path` any Flow document quotes as an example — including this file's own comments.
 */
export function parseImports(text) {
  const out = [];
  let fenced = false;
  for (const rawLine of String(text ?? "").split("\n")) {
    // A fence is ``` or ~~~ at the start of a line (allowing indentation inside a list item).
    if (/^\s{0,3}(```|~~~)/.test(rawLine)) { fenced = !fenced; continue; }
    if (fenced) continue;
    // Blank out inline-code spans before scanning, so the `@path` inside them cannot match while
    // the surrounding prose still can. Replaced with spaces, not removed: the boundary character
    // before a real `@` on the same line must survive.
    const line = rawLine.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const m of line.matchAll(IMPORT_RE)) {
      if (!out.includes(m[2])) out.push(m[2]);
    }
  }
  return out;
}

/**
 * Walk the import graph from `<repoRoot>/CLAUDE.md`.
 *
 * Returns `{ files, problems, refused }`:
 *   · `files`   — `{ path, bytes, depth }` per UNIQUE file, entry first. A file reachable by two
 *                 different routes (a diamond import) appears once and its bytes are counted
 *                 once, which is what a session actually loads.
 *   · `problems`— an `@path` that resolves to no file, named. NOT counted as zero: the template's
 *                 own reason is already written down — "a pointer that silently does not resolve
 *                 is worse than no pointer at all". A repo that adds `@.flow/PROTOCOL.md` without
 *                 the file present has a CLAUDE.md with no protocol in it and no error anywhere.
 *                 This is what catches that.
 *   · `refused` — imports beyond `MAX_IMPORT_DEPTH`, which Claude Code would not load either.
 *
 * Paths in an import are resolved relative to THE FILE CONTAINING THEM, not to the repo root —
 * which is what keeps a nested `@sibling.md` correct.
 */
export function resolveImportSet(repoRoot, { entry } = {}) {
  if (!entry) throw new TypeError(USAGE);
  const entryAbs = resolve(repoRoot, entry);
  const files = [];
  const problems = [];
  const refused = [];
  const seen = new Set();

  // `realpathSync` where the file exists, so two routes to one file collapse even through a
  // symlink; the resolved path otherwise, so a problem message names what was written.
  const key = (abs) => { try { return realpathSync(abs); } catch { return abs; } };
  const rel = (abs) => relative(repoRoot, abs) || abs;
  const rootReal = key(resolve(repoRoot));
  const within = (root, abs) => {
    const r = relative(root, abs);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  const insideRepo = (abs) => within(resolve(repoRoot), abs) && within(rootReal, key(abs));

  if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
    return {
      files,
      problems: [`no ${entry} at the repo root (${rel(entryAbs)}) — nothing to measure. An empty ` +
        `check is a failure, not a pass: the same rule build and lint follow.`],
      refused,
    };
  }

  const queue = [{ abs: entryAbs, depth: 0, from: null }];
  while (queue.length) {
    const { abs, depth, from } = queue.shift();
    const k = key(abs);
    if (seen.has(k)) continue;                       // diamond import: counted once, already in
    seen.add(k);

    const text = readFileSync(abs, "utf8");
    files.push({ path: rel(abs), bytes: Buffer.byteLength(text, "utf8"), depth });

    for (const spec of parseImports(text)) {
      const target = resolve(dirname(abs), spec);
      // CONFINED TO THE REPO, checked before anything touches the target. The file being walked
      // arrives in the very PR being gated, so `@/home/runner/.npmrc` or `@../../x.md` is
      // attacker-controlled input: following it would make the gate stat and read files outside
      // the checkout and print their paths and sizes into a public CI log. The lexical check
      // catches `/` and `../`; the realpath check catches an in-repo symlink pointing out. Either
      // way it is an unresolved import — a hard failure, never a silent zero.
      if (!insideRepo(target)) {
        problems.push(`unresolved import @${spec} in ${rel(abs)} — it points outside the ` +
          `repository, which is never followed. An import must name a file in this repo.`);
        continue;
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        problems.push(`unresolved import @${spec} in ${rel(abs)} — it resolves to ` +
          `${rel(target)}, which does not exist. A pointer that silently does not resolve is ` +
          `worse than no pointer at all: the session loads nothing there and reports nothing.`);
        continue;
      }
      if (depth + 1 > MAX_IMPORT_DEPTH) {
        refused.push(`@${spec} in ${rel(abs)} is ${depth + 1} hops from ${entry} — past Claude ` +
          `Code's limit of ${MAX_IMPORT_DEPTH}, so it is NOT loaded into the session and is NOT ` +
          `counted here. Flatten the chain if that file is meant to reach context.`);
        continue;
      }
      queue.push({ abs: target, depth: depth + 1, from: abs });
    }
    void from;
  }
  return { files, problems, refused };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The ceiling, from .flow/config.yml
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read `claude_md_max` from config.yml. Returns `{ exists, declared, value, problem }` —
 * `declared: false` when the key is absent, which is NOT an error (see `checkClaudeMd`).
 * A present-but-unparseable value IS an error: a typo'd ceiling that read as "no ceiling"
 * would switch the check off while looking configured.
 */
export function parseCeiling(configPath) {
  if (!existsSync(configPath)) return { exists: false, declared: false, value: null, problem: null };
  const lines = readFileSync(configPath, "utf8").split("\n");
  for (const line of lines) {
    const m = new RegExp(`^${CEILING_KEY}:\\s*(.*)$`).exec(line);
    if (!m) continue;
    const raw = m[1].split("#")[0].trim().replace(/^["'](.*)["']$/, "$1");
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value <= 0) {
      return {
        exists: true, declared: true, value: null,
        problem: `${CEILING_KEY} in config.yml is "${raw}", which is not a positive number of ` +
          `bytes. Fix it or remove the key — a ceiling that cannot be parsed must not read as ` +
          `"no ceiling".`,
      };
    }
    return { exists: true, declared: true, value, problem: null };
  }
  return { exists: true, declared: false, value: null, problem: null };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The verdict
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The whole check as data. `ok: false` is the gate-failing verdict; `decision` names WHY, so a
 * CI log distinguishes "over the ceiling" from "nothing to measure" from "unresolved pointer".
 *
 * `warnings` is for the one case that must NOT fail: a repo with no `claude_md_max` declared.
 * Adoption must not break the fleet — every repo that pinned this workflow before the key existed
 * would go red at once — so the missing key is a loud warning here.
 */
export function checkClaudeMd({
  repoRoot, entry, configPath = join(repoRoot, ".flow", "config.yml"),
} = {}) {
  const { files, problems, refused } = resolveImportSet(repoRoot, { entry });
  const ceiling = parseCeiling(configPath);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  // Largest first, so the output names the file to cut rather than leaving the reader to sort it.
  const breakdown = [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const all = [...problems];
  if (ceiling.problem) all.push(ceiling.problem);
  const warnings = [];

  if (all.length) {
    return {
      ok: false,
      decision: files.length ? "unresolved-import" : "no-host-file",
      total, ceiling: ceiling.value, files: breakdown, refused, problems: all, warnings,
    };
  }
  if (!ceiling.declared) {
    warnings.push(`no ceiling declared — ${CEILING_KEY} is absent from .flow/config.yml, so the ` +
      `resolved total of ${total} bytes across ${files.length} file(s) is REPORTED AND NOT ` +
      `ENFORCED. Add \`${CEILING_KEY}: <bytes>\` beside \`coverage_min\` to turn this into a gate.`);
    return {
      ok: true, decision: "no-ceiling-declared",
      total, ceiling: null, files: breakdown, refused, problems: all, warnings,
    };
  }
  const over = total > ceiling.value;
  return {
    ok: !over,
    decision: over ? "over-ceiling" : "within-ceiling",
    total, ceiling: ceiling.value, headroom: ceiling.value - total,
    files: breakdown, refused, problems: all, warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Print the verdict and return the process exit code. Never calls `process.exit`, so a test can
 * drive it. The first line is always `check-claude-md: decision=<...>`, the same
 * `<name>: decision=` contract the store- and touches-guards print — free-text prose above or
 * below it may be reworded, that prefix may not.
 */
export function main(argv, {
  repoRoot,
  configPath = join(repoRoot, ".flow", "config.yml"),
  env = process.env,
  stdout = (s) => console.log(s),
  stderr = (s) => console.error(s),
} = {}) {
  const entry = resolveEntry(argv, env);
  if (!entry) {
    // Exit 2, the usage code — distinct from 1, so "you invoked it wrong" is never mistaken in a
    // CI log for "this repo is over its ceiling".
    stderr(USAGE);
    return 2;
  }
  const r = checkClaudeMd({ repoRoot, entry, configPath });

  if (argv.includes("--json")) {
    stdout(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }

  stdout(`check-claude-md: decision=${r.decision} entry=${entry} total=${r.total} ` +
    `ceiling=${r.ceiling ?? "none"} files=${r.files.length}`);
  for (const line of r.refused) stdout(`  note   ${line}`);

  if (r.problems.length) {
    for (const p of r.problems) stderr(`::error::${p}`);
    return 1;
  }
  if (r.warnings.length) {
    for (const w of r.warnings) stdout(`::warning::${w}`);
  }

  if (r.decision === "over-ceiling") {
    stderr(`::error::${entry}'s resolved import set is ${r.total} bytes, over the ` +
      `${CEILING_KEY} of ${r.ceiling} by ${r.total - r.ceiling}. This is what a session actually ` +
      `loads, so moving prose behind an import does not reduce it — cut it, or raise the ` +
      `ceiling deliberately and say why.`);
    stderr(`Resolved set, largest first — ${plural(r.files.length, "file")}:`);
    for (const f of r.files) stderr(`  ${String(f.bytes).padStart(7)}  ${f.path}`);
    return 1;
  }
  if (r.decision === "within-ceiling") {
    stdout(`${entry}'s resolved import set is ${r.total} bytes across ` +
      `${plural(r.files.length, "file")}, ${r.headroom} under the ${CEILING_KEY} of ${r.ceiling}.`);
  }
  return 0;
}

// The tree this file governs: `<root>/.flow/bin/check-claude-md.mjs` → `<root>`. Resolved from the
// REALPATH of this module, which is why a symlinked `.flow/bin` would measure the wrong repo.
export function templateRepoRoot(here = fileURLToPath(import.meta.url)) {
  return resolve(dirname(realpathSync(here)), "..", "..");
}

// --- main-module detection (do not simplify back to a string compare) -------------------
// See project-template/.flow/bin/parse-task-id.mjs for the incident this guards against.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

if (__isMain) {
  process.exit(main(process.argv.slice(2), { repoRoot: templateRepoRoot() }));
}
