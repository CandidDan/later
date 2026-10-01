#!/usr/bin/env node
// flow-sync.mjs — the adopt mechanism (propagation plan, Phase 4). Flow infra is authored in
// canonical (CandidDan/flow) and repos *adopt* it; this is the "pull canonical in" half of that
// contract. The reusable _flow-sync.yml workflow compares this repo's `.flow/VERSION` against
// canonical's and, when behind, copies the updated infra in and opens a **reviewed PR**
// (Dependabot-style) — the update still has to clear the gate before it lands. This module is the
// pure brain: the version decision and the PR text. Zero deps (Node >= 18). Unit-tested.
//
//   node .flow/bin/flow-sync.mjs decide   --local 1.0.0 --canonical 1.2.0   # -> "behind"
//   node .flow/bin/flow-sync.mjs branch    --canonical 1.2.0                # -> "flow-sync/1.2.0"
//   node .flow/bin/flow-sync.mjs existing --branch-exists yes --open-pr 286 \
//        --head-canonical-sha abc123 --canonical-sha def456                 # -> "refresh"
//   node .flow/bin/flow-sync.mjs extra-jobs --local .github/workflows/flow-gates.yml \
//        --incoming "$CANON_TPL/.github/workflows/flow-gates.yml"       # -> "edge-parse\nmcp-build"
//   node .flow/bin/flow-sync.mjs pr-title --local 1.0.0 --canonical 1.2.0
//   node .flow/bin/flow-sync.mjs pr-body  --local 1.0.0 --canonical 1.2.0 --files "$CHANGED" \
//        --kept "$KEPT"
//
// `--files` is `git diff --cached --no-renames --name-status` output — `<STATUS>\t<path>` per
// line, computed AFTER `git add -A`. It was the pre-`add` worktree diff until flow-0054, which
// omitted every newly created file and could render a PR body asserting that none differed.
//
// Why a PR and not a direct push: the governance rule (CLAUDE.md "Hard rules") is *repos adopt
// canonical; they don't patch infra locally* — but adoption must still clear the same
// Definition-of-Done gate as any other change, so a bad sync is caught before it reaches main.
// A flow-sync/<version> branch isn't a flow/<id> branch, so touches-guard skips it and the
// store-guard (which only blocks .flow/tasks/ edits) passes — yet flow-gates' flow-tooling job
// still runs the *synced* tests + flow-doctor, so the gate validates the update for free.
//
// The version comparison is imported from flow-doctor (single source of truth — it also powers
// the drift *warning*; flow-sync is the drift *fix*).

import { compareVersions } from "./flow-doctor.mjs";


import { readFileSync as __readFileSync, realpathSync as __realpathSync } from "node:fs";
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
// Decide what a repo at `local` should do relative to canonical at `canonical`:
//   "behind"  — local < canonical (or no stamp at all): open a sync PR.
//   "current" — equal: nothing to do.
//   "ahead"   — local > canonical: the repo is somehow newer than canonical (a local hand-edit,
//               or a canonical tag not yet cut). Never sync backwards — surface it so the change
//               is reconciled *upward* into canonical instead.
export function decide(local, canonical) {
  if (!canonical) throw new Error("flow-sync: canonical version is required");
  if (!local) return "behind"; // no stamp yet — adopt the version stamp + infra
  const cmp = compareVersions(local, canonical);
  if (cmp < 0) return "behind";
  if (cmp > 0) return "ahead";
  return "current";
}

// The sync branch name. Stable per target version so a second run is idempotent — the workflow
// reuses (not duplicates) an open sync PR for the same canonical version.
export function syncBranch(canonical) {
  return `flow-sync/${canonical}`;
}

// ── the leftover-branch decision (flow-0075) ────────────────────────────────────────────
//
// `syncBranch` is stable per target version, and for four releases `_flow-sync.yml` read *the
// branch exists* as *a sync PR is open*: it logged that claim without checking it and exited 0.
// A sync PR closed without merging leaves its branch behind, so that version could never be
// offered again — every later run went green saying a PR was open when none was. Observed in
// CandidDan/Nudge: `flow-sync/2.0.0` outlived a closed-unmerged PR (Nudge#286), and the only way
// out was deleting the branch by hand (Nudge#297).
//
// The rule is a pure function so it is testable with no network. The workflow gathers the facts
// (`git ls-remote`, `gh pr list --head <branch> --state open`, the head commit's trailer) and
// acts on the verdict:
//
//   branch exists | open PR | head's Canonical-SHA vs now | verdict
//   --------------|---------|-----------------------------|--------
//   no            |    —    |             —               | create   fresh branch, push, open a PR
//   yes           |   no    |            any              | rebuild  force-with-lease, open a PR
//   yes           |  yes    |   differs, or no trailer    | refresh  force-with-lease, no new PR
//   yes           |  yes    |            equal            | noop     the open PR is already current
//
// `refresh` opens nothing because the open PR picks up the new head by itself.
export const CANONICAL_SHA_TRAILER = "Canonical-SHA";

// The sync commit records the canonical commit it was built from as a `Canonical-SHA:` trailer,
// and `refresh` compares against it. A branch whose head carries NO trailer — every branch built
// before flow-0075 — counts as stale rather than current. That is the safe direction: the worst
// case is one unnecessary rebuild, whereas guessing "current" is the bug being fixed.
function sameCanonicalSha(recorded, now) {
  const a = String(recorded ?? "").trim().toLowerCase();
  const b = String(now ?? "").trim().toLowerCase();
  return a !== "" && a === b;
}

// A fact that could not be gathered must never become a verdict — least of all `noop`, which is
// the silent-green failure this whole subcommand exists to remove. So every input is parsed
// strictly and an unrecognised one throws, which the CLI turns into a non-zero exit and the
// workflow into an `::error`. "Absent" and "unreadable" are different answers.
function parseBranchExists(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(v)) return true;
  if (["no", "false", "0"].includes(v)) return false;
  throw new Error(
    `flow-sync: --branch-exists must be yes or no, got ${JSON.stringify(String(value ?? ""))}. ` +
    `An ungathered fact is not a verdict.`);
}

// The open-PR fact, as `gh pr list --head <branch> --state open` reports it: a PR number, or an
// empty string for "none". Anything else is a lookup that did not answer the question — gh's
// error text, a jq null — and is refused rather than read as "no PR".
function parseOpenPr(value) {
  const v = String(value ?? "").trim();
  if (v === "") return null;
  if (!/^#?\d+$/.test(v)) {
    throw new Error(
      `flow-sync: --open-pr must be a PR number or empty, got ${JSON.stringify(v)}. ` +
      `A failed lookup must fail the run, not choose a verdict.`);
  }
  return Number(v.replace("#", ""));
}

/**
 * Decide what to do about a sync branch that may already exist.
 *
 * @param {object} facts
 * @param {boolean|string} facts.branchExists      does `flow-sync/<version>` exist on origin?
 * @param {string|number|null} facts.openPr        the open PR's number from that branch, or "" / null
 * @param {string} facts.headCanonicalSha          the branch head's `Canonical-SHA` trailer ("" if none)
 * @param {string} facts.canonicalSha              the canonical commit being synced now
 * @returns {"create"|"rebuild"|"refresh"|"noop"}
 */
export function decideExisting({ branchExists, openPr, headCanonicalSha, canonicalSha } = {}) {
  // Required for the same reason `decide` requires a canonical version: without it every
  // comparison below is against nothing, and "nothing" would compare equal to a branch with no
  // trailer and answer `noop`.
  if (!String(canonicalSha ?? "").trim()) {
    throw new Error("flow-sync: canonical SHA is required to decide about an existing sync branch");
  }
  if (!parseBranchExists(branchExists)) return "create";
  if (parseOpenPr(openPr) === null) return "rebuild";
  return sameCanonicalSha(headCanonicalSha, canonicalSha) ? "noop" : "refresh";
}

// ── the customised-caller guard (flow-0076) ─────────────────────────────────────────────
//
// A Flow caller is meant to be thin: `.github/workflows/flow-gates.yml` in an adopting repo just
// `uses:` canonical's reusable. A repo that needs something the reusable cannot express adds jobs
// to its own caller — CandidDan/Nudge's `edge-parse`, `mcp-build` and `mobile-check`, one per tree.
// The copy loop in `_flow-sync.yml` was a bare `cp` over the local file, so every sync deleted
// those jobs, and the PR body listed the caller as "Modified" and nothing else. `edge-parse` is the
// guard against a Deno parse error reaching production as a BOOT_ERROR; the last time it was absent
// cost about seven days of dropped WhatsApp inbounds. A gate that stops checking while staying
// green is the worst failure this repo can ship, and a sync shipped it silently.
//
// WHAT "CUSTOMISED" MEANS HERE, AND WHY IT IS NOT A TEXT DIFF. The obvious reading — keep a caller
// that differs from the PREVIOUS template in more than its pin — needs the previous version's
// template, which a sync run does not have; and a diff against the INCOMING template would flag
// every caller canonical legitimately changed, which is most of them. So the rule is the factual
// one, and it is exactly the case where copying destroys work: a caller is kept when it declares a
// top-level job key that the incoming template file does not. A caller that differs in any other
// way — its `uses:` pin, a `with:` input, a schedule — is overwritten exactly as before.
//
// NO YAML PARSER. This module runs in the adopting repo BEFORE any install step (the reusable
// invokes it straight out of canonical's clone), so it stays zero-dependency like the rest of the
// file and reads job keys with a line scan.

// Job ids as GitHub defines them: must start with a letter or `_`, then letters, digits, `-` or `_`.
// Anchored to the whole line — a job key is a mapping key, so nothing but an optional comment may
// follow the colon. That is what keeps `uses: ./x` or `run: |` from ever being read as a job.
const JOB_KEY_LINE = /^([ \t]*)([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?:#.*)?$/;

/**
 * The top-level job keys a workflow file declares, in declaration order.
 *
 * The scan starts at a `jobs:` key in column 0 and takes every key at the indent of the FIRST key
 * it finds under it. Reading the indent off the file rather than hardcoding two spaces costs one
 * line and means a caller indented with four does not silently report zero jobs — and "zero jobs"
 * is the answer that lets the copy proceed, so a scan that fails has to fail towards reporting
 * MORE, never fewer. Blank lines and comment lines at any depth are skipped; a non-blank line back
 * in column 0 is the next top-level key and ends the block. Deeper lines are a job's own contents
 * (`steps:`, `with:`) and are not compared, which is what "top-level job keys" means.
 *
 * Limit, stated rather than hidden: a flow-style `jobs: {gate: …}` is not read, because the opening
 * line then carries the whole mapping and this returns []. No generated or hand-written Flow caller
 * uses that form; if one ever does, it syncs as it did before this guard existed.
 */
export function topLevelJobKeys(text) {
  const keys = [];
  let inJobs = false;
  let indent = null;
  // CRLF too: a caller hand-edited on Windows would otherwise keep a `\r` on every line, `jobs:\r`
  // would never match, and the scan would report zero jobs — the unsafe direction.
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!inJobs) {
      if (/^jobs:[ \t]*(?:#.*)?$/.test(line)) inJobs = true;
      continue;
    }
    if (/^[ \t]*$/.test(line)) continue;      // blank
    if (/^[ \t]*#/.test(line)) continue;      // comment, at any depth
    const lead = line.match(/^[ \t]*/)[0];
    if (lead === "") break;                   // back in column 0: the next top-level key
    if (indent === null) indent = lead;       // the first key sets what "directly under" means
    if (lead !== indent) continue;            // deeper: inside a job
    const match = line.match(JOB_KEY_LINE);
    if (match && !keys.includes(match[2])) keys.push(match[2]);
  }
  return keys;
}

/**
 * The job keys `localText` declares that `incomingText` does not — the jobs a `cp` would delete.
 * Empty means the caller is safe to overwrite.
 */
export function extraJobs(localText, incomingText) {
  const incoming = new Set(topLevelJobKeys(incomingText));
  return topLevelJobKeys(localText).filter((key) => !incoming.has(key));
}

// One kept caller per line: `<path>\t<job> <job> …`, as the workflow's loop accumulates them.
// A line with no tab is a path whose jobs were not recorded; it is still listed, because naming
// the file that did not sync matters more than naming the jobs, and dropping the entry would put
// the PR body back to not mentioning it at all.
export function parseKept(kept = []) {
  const lines = Array.isArray(kept) ? kept : String(kept).split("\n");
  return lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => {
      const [path, ...rest] = line.split("\t");
      return { path: path.trim(), jobs: rest.join(" ").split(/[\s,]+/).filter(Boolean) };
    })
    .filter((entry) => entry.path);
}

// The version stamp is reported on its own line above the file list, so it is deliberately NOT
// counted as an "infra file" when deciding whether anything differed. Without that exclusion the
// one true stamp-only case is unreachable: `_flow-sync.yml` rewrites this file on every sync, so
// the staged tree it now reads is never empty (flow-0054).
const VERSION_STAMP = ".flow/VERSION";

// One entry per line of `git diff --cached --no-renames --name-status`: `<STATUS>\t<path>`.
// A line with no tab is a bare path — the shape `--name-only` produced before flow-0054, and the
// shape a hand-run `pr-body` still takes. Its class is unknown, so it is reported as unknown
// rather than guessed at: mislabelling an added file "modified" is the same lie in a smaller font.
export function parseChanges(files = []) {
  const lines = Array.isArray(files) ? files : String(files).split("\n");
  return lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      // Last field, not fields[1]: a rename arrives as `R100\told\tnew` and the new path is what
      // the repo ends up with. The workflow passes `--no-renames` so it never sends one, but the
      // CLI is callable by hand and must not render `old\tnew` as a single path.
      return fields.length > 1
        ? { status: fields[0], path: fields[fields.length - 1] }
        : { status: null, path: line };
    });
}

// Which heading an entry is listed under. `A`/`M`/`D` are the only statuses `--no-renames` can
// produce; anything else (a typechange, a rename from a hand-run, a bare path) is grouped as
// "Changed", which claims nothing beyond the fact that the file is in the diff.
function groupOf(status) {
  const key = status ? status[0] : "";
  if (key === "A") return "Added";
  if (key === "M") return "Modified";
  if (key === "D") return "Removed";
  return "Changed";
}

const GROUP_ORDER = ["Added", "Modified", "Removed", "Changed"];

// PR title + body for an adoption. `files` is the sync's changed-file list, as `--name-status`
// lines (see parseChanges).
export function prContent({ local, canonical, files = [], kept = [] }) {
  const title = `flow: adopt canonical Flow infra ${canonical}`;
  const changes = parseChanges(files);
  const keptCallers = parseKept(kept);
  // Added and removed files are listed apart from modified ones because a sync's whole payload
  // can be additions — new thin callers, new `.flow/bin/` helpers — and those are the files that
  // will execute in this repo's CI. Flattening them into one undifferentiated list is what let a
  // 37-file sync read as a 22-file one (flow-0054, note 6).
  const sections = GROUP_ORDER
    .map((name) => [name, changes.filter((c) => groupOf(c.status) === name)])
    .filter(([, entries]) => entries.length > 0)
    .flatMap(([name, entries]) => [
      `**${name}** (${entries.length})`,
      ``,
      ...entries.map((c) => `- \`${c.path}\``),
      ``,
    ]);
  const fileLines = changes.some((c) => c.path !== VERSION_STAMP)
    ? sections.slice(0, -1).join("\n")   // drop the trailing blank; the body supplies its own
    : "- _(version stamp only — no infra files differed)_";
  // The callers this sync deliberately did NOT copy (flow-0076). Absent when there are none, so a
  // normal sync's body is unchanged — a section reading "Kept: none" on every PR is the kind of
  // boilerplate a reviewer learns to skip, and this one has to be read the one time it appears.
  const keptSection = keptCallers.length === 0 ? [] : [
    ``,
    `### Kept: customised callers`,
    ``,
    `Each of these declares a job canonical's template does not, so copying canonical's version`,
    `would have **deleted** it. The file was left exactly as it is, and therefore does **not**`,
    `receive this version's changes to it — reconcile it by hand, or move those checks into`,
    `\`.flow/config.yml\`'s \`source_roots\` so a thin caller can express them.`,
    ``,
    ...keptCallers.map(({ path, jobs }) => jobs.length
      ? `- \`${path}\` — extra jobs: ${jobs.map((j) => `\`${j}\``).join(", ")}`
      : `- \`${path}\` — extra jobs not recorded`),
  ];
  const body = [
    `Adopts Flow infra **${canonical}** from canonical (\`CandidDan/flow\`).`,
    ``,
    `- repo \`.flow/VERSION\`: \`${local || "(none)"}\` → \`${canonical}\``,
    ``,
    `### Synced from canonical`,
    ``,
    fileLines,
    ...keptSection,
    ``,
    `Opened by **flow-sync** (Phase 4 adopt mechanism). Flow infra is authored in canonical and`,
    `repos adopt it — this PR *is* that pull, kept reviewable so the update still clears the gate`,
    `before it lands. Review the diff, let the gate run, then merge.`,
  ].join("\n");
  return { title, body };
}

// ── tiny CLI ── one subcommand per line of shell in _flow-sync.yml. Always exits 0 on success.
function arg(flags, name) {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 && i + 1 < flags.length ? flags[i + 1] : undefined;
}

if (__isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const local = arg(rest, "local") || "";
  const canonical = arg(rest, "canonical") || "";
  switch (cmd) {
    case "decide":
      process.stdout.write(decide(local, canonical) + "\n");
      break;
    case "branch":
      process.stdout.write(syncBranch(canonical) + "\n");
      break;
    case "existing": {
      // The three gathered facts plus the SHA being synced now. Every one of them is passed
      // explicitly: this subcommand reads no files and makes no network call, which is what lets
      // the rule be unit-tested. A malformed fact throws, and the throw is left to propagate —
      // node exits non-zero, `set -e` stops the workflow, and no verdict is printed. Catching it
      // here to print a default would recreate the silent green this exists to remove.
      process.stdout.write(decideExisting({
        branchExists: arg(rest, "branch-exists"),
        openPr: arg(rest, "open-pr"),
        headCanonicalSha: arg(rest, "head-canonical-sha"),
        canonicalSha: arg(rest, "canonical-sha"),
      }) + "\n");
      break;
    }
    case "extra-jobs": {
      // `--local` is a PATH here, not a version. Both files are read with no try/catch on purpose:
      // an unreadable file throws, node exits non-zero and `set -e` stops the sync. The failure
      // mode being avoided is the quiet one — printing nothing for a file that could not be read
      // is indistinguishable from "no extra jobs", which is the verdict that copies over it.
      const localPath = arg(rest, "local");
      const incomingPath = arg(rest, "incoming");
      if (!localPath || !incomingPath) {
        console.error("usage: flow-sync.mjs extra-jobs --local FILE --incoming FILE");
        process.exit(2);
      }
      const extra = extraJobs(__readFileSync(localPath, "utf8"), __readFileSync(incomingPath, "utf8"));
      // Nothing at all when there are none: the workflow tests the output with `[ -n "$EXTRA" ]`,
      // so a stray blank line would read as a customised caller and stop every sync.
      if (extra.length) process.stdout.write(extra.join("\n") + "\n");
      break;
    }
    case "pr-title":
      process.stdout.write(prContent({ local, canonical }).title + "\n");
      break;
    case "pr-body": {
      // Handed straight to parseChanges, which owns the line splitting: the shell passes
      // `--name-status` output, and the status column must survive the trip.
      process.stdout.write(prContent({
        local, canonical,
        files: arg(rest, "files") || "",
        // `<path>\t<jobs>` lines from the caller-copy loop. Omitted on a sync that kept nothing,
        // in which case the section does not render at all.
        kept: arg(rest, "kept") || "",
      }).body + "\n");
      break;
    }
    default:
      console.error("usage: flow-sync.mjs <decide|branch|existing|extra-jobs|pr-title|pr-body> --local X --canonical Y [--files ...] [--kept ...]\n" +
        "       flow-sync.mjs extra-jobs --local <workflow file> --incoming <workflow file>\n" +
        "       flow-sync.mjs existing --branch-exists <yes|no> --open-pr <number|''> --head-canonical-sha <sha|''> --canonical-sha <sha>");
      process.exit(2);
  }
  process.exit(0);
}
