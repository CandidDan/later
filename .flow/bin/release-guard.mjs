#!/usr/bin/env node
// release-guard.mjs — refuse to publish a version stamp that disagrees with the tree it stamps.
//
// THE PROBLEM IT SOLVES. `flow-sync` decides whether a consuming repo is behind by comparing
// canonical's `project-template/.flow/VERSION` against the repo's `.flow/VERSION` and nothing
// else — not the tag, not the tree, not the commit date. That is deliberate: the stamp is the
// cheap, offline, dependency-free comparison. It is also fine *only while the stamp is true*,
// and until this guard nothing made it true.
//
// On 2026-08-19 three different trees carried the stamp `1.1.0` — including `v1.1.1`, the tag
// cut to publish the touches-guard fail-open fix. Sync compared 1.1.0 against 1.1.0, decided
// `current`, exited 0 and reported success nightly. The fix was published and reached nobody.
// Same signature as the bug it failed to deliver: the wrong answer arrives quietly, in the
// direction that looks healthy.
//
// FOUR WAYS THE STAMP CAN LIE, and what each is worth:
//   1. tag/stamp disagreement — a tag `vX.Y.Z` on a commit whose VERSION is not X.Y.Z.  PROBLEM
//   2. internal stamp drift  — the two VERSION files naming different releases.          PROBLEM
//   3. silent staleness      — main past the last tag with the stamp unmoved.            warning
//   4. alias rot             — `v1` (what the fleet pins) drifting behind main.          warning
//
// 3 and 4 are warnings on purpose. Moving `v1` is a deliberate human step (see the header of
// `release-tag.yml`); a release path that hard-fails on a deliberate manual step teaches people
// to bypass it. What was missing was never the failure — it was the *number*. If the warning
// proves too easy to ignore, the escalation is a scheduled report, not a stricter release gate.
//
// SPLIT, the way the other helpers are split:
//   · `checkRelease(facts)` is pure — no IO, no clock, no `git`. Every branch is a plain object.
//   · the git reads are a thin injected layer (`makeGitRunner`, `collectFacts`), so the whole
//     thing is exercisable against a temp repo with no remote.
//
//   node release-guard.mjs [--tag <name>] [--main <ref>] [--alias <ref>] [--repo <dir>] [--json]
//
// Exits 1 when it finds a problem, 0 otherwise (warnings never fail). Zero dependencies.

import { execFileSync } from "node:child_process";
import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { compareVersions } from "./flow-doctor.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reached
// through a symlink they differ, the comparison is false, and the CLI block silently never runs
// — no output, exit 0, nothing to debug. For a guard that means it fails OPEN: the release path
// reports success having checked nothing, which is the exact failure mode this file exists to
// end. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// A published release tag: `v1.2.0`. Deliberately NOT the aliases — `v1` and `v1-edge` are
// floating pointers and are *expected* not to carry a matching stamp, so they are skipped by
// the tag/stamp check rather than failed by it.
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

// The shape `release-tag.yml` already enforces for its own alias derivation. Anything else is a
// problem, not something to coerce into a comparison.
export const SEMVER = /^\d+\.\d+\.\d+$/;

// Canonical's two stamps. Repo-relative, because every read goes through `git show <ref>:<path>`.
export const ROOT_VERSION_PATH = "VERSION";
export const TEMPLATE_VERSION_PATH = "project-template/.flow/VERSION";

// ── pure: the verdict ──────────────────────────────────────────────────────────────────
// Given everything already resolved — a tag name, the stamps, the commit distances — return
// `{ problems, warnings }`. Problems exit non-zero; warnings are information and exit 0.
//
// Trailing bytes: every value here is compared TRIMMED. Canonical's two VERSION files have no
// trailing newline while `_flow-sync.yml` writes an adopted repo's stamp with `printf '%s\n'`,
// so a byte-equality assertion would fail across the adopt boundary while nothing is wrong.
export function checkRelease(facts = {}) {
  const {
    tag = "",
    tagVersion = null,
    rootVersion = null,
    templateVersion = null,
    rootPath = ROOT_VERSION_PATH,
    templatePath = TEMPLATE_VERSION_PATH,
    latestReleaseTag = null,
    latestReleaseVersion = null,
    mainAhead = 0,
    mainRef = "main",
    aliasRef = null,
    aliasBehind = 0,
  } = facts;

  const problems = [];
  const warnings = [];
  const trim = (v) => (typeof v === "string" ? v.trim() : v);

  const root = trim(rootVersion);
  const template = trim(templateVersion);

  // ── 1. stamp shape ── an unparseable stamp is reported, never parsed into a comparison.
  const shapeOk = (path, value) => {
    if (value === null || value === undefined || value === "") {
      problems.push(`${path}: no stamp found — cannot verify what this tree claims to be.`);
      return false;
    }
    if (!SEMVER.test(value)) {
      problems.push(
        `${path} is "${value}", expected MAJOR.MINOR.PATCH — refusing to compare an ` +
        `unparseable stamp (the same shape release-tag.yml enforces to derive its aliases).`,
      );
      return false;
    }
    return true;
  };
  const rootOk = shapeOk(rootPath, root);
  const templateOk = shapeOk(templatePath, template);

  // ── 2. internal stamp drift ── the two files are pinned to each other by nothing else.
  // `release-tag.yml` derives the alias names from the first; `flow-sync` compares the second.
  // Either moving alone publishes a lie. An agreeing pair is SILENT — not "ok" noise.
  if (rootOk && templateOk && root !== template) {
    problems.push(
      `stamp drift: \`${rootPath}\` is ${root} but \`${templatePath}\` is ${template} — ` +
      `both must name the same release. release-tag.yml derives the alias from ${rootPath}; ` +
      `flow-sync compares ${templatePath}, so the fleet would sync against ${template}.`,
    );
  }

  // ── 3. tag/stamp agreement ── the 2026-08-19 incident itself.
  if (RELEASE_TAG.test(tag)) {
    const expected = tag.slice(1);
    const found = trim(tagVersion);
    if (found === null || found === undefined || found === "") {
      problems.push(
        `${tag}: could not read \`${rootPath}\` at \`${tag}^{commit}\` — the tag cannot be ` +
        `shown to stamp the tree it points at.`,
      );
    } else if (found !== expected) {
      problems.push(
        `${tag} tags a tree whose \`${rootPath}\` reads ${found}, expected ${expected} — ` +
        `flow-sync compares stamps, so publishing this tag ships the change to nobody while ` +
        `reporting success. Repair it deliberately, from a human: either retag ${tag} onto a ` +
        `commit stamped ${expected}, or cut a NEW release tag at a tree whose stamp is true ` +
        `(the newest release is what this check follows). The guard never retags anything itself.`,
      );
    }
  }

  // ── 4. silent staleness on main ── only when the stamp has NOT moved: commits past the last
  // tag with an unchanged stamp are un-publishable-by-sync by construction. A stamp already
  // bumped ahead of the tag is a release in flight, which is normal and legible.
  if (rootOk && latestReleaseTag && mainAhead > 0 && trim(latestReleaseVersion) === root) {
    warnings.push(
      `${mainRef} is ${mainAhead} commit(s) ahead of ${latestReleaseTag} with \`${rootPath}\` ` +
      `still ${root} — every one of those commits is invisible to flow-sync until the stamp moves.`,
    );
  }

  // ── 5. alias rot ── measured, never failed. See the header for why.
  if (aliasRef && aliasBehind > 0) {
    warnings.push(
      `${aliasRef} is ${aliasBehind} commit(s) behind ${mainRef} — the fleet pins ${aliasRef}, ` +
      `so that is how far back it is running. Moving ${aliasRef} is a deliberate human step ` +
      `(see release-tag.yml); this is the measure of the gap, not a failure.`,
    );
  }

  return { problems, warnings };
}

// The highest `vX.Y.Z` among `tags`, or null. Aliases are filtered out before the sort, so a
// `v1` or `v1-edge` in the list can never be mistaken for the newest release.
export function highestReleaseTag(tags = []) {
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  if (!releases.length) return null;
  return releases
    .slice()
    .sort((a, b) => compareVersions(a.slice(1), b.slice(1)))
    .pop();
}

// The floating alias a stamp implies: `1.2.0` -> `v1`. Null when the stamp is unparseable —
// there is no honest alias to name, and check 1 has already reported the stamp.
export function aliasForVersion(version) {
  const v = typeof version === "string" ? version.trim() : version;
  if (!v || !SEMVER.test(v)) return null;
  return `v${v.split(".")[0]}`;
}

// ── git IO ── injected everywhere below, so the tests drive real fixtures or plain fakes.
export function makeGitRunner(cwd) {
  return (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Every git read is best-effort: a ref that does not exist is an absent fact, not a crash.
function attempt(git, args) {
  try {
    const out = git(args);
    return out === null || out === undefined ? null : String(out);
  } catch {
    return null;
  }
}

// Resolve a ref to a COMMIT sha. `^{commit}` is the whole point: canonical's release tags are
// annotated, so `rev-parse v1.1.1` yields the *tag object* (9a29a00), not the commit (d751e97).
// Reading a blob at the tag object is what produced a wrong diagnosis of this very incident.
export function resolveCommit(git, ref) {
  const out = attempt(git, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return out ? out.trim() : null;
}

// A file's contents at a ref, trimmed. Null when the ref or the path is absent.
export function readFileAtRef(git, ref, path) {
  const out = attempt(git, ["show", `${ref}:${path}`]);
  return out === null ? null : out.trim();
}

// The stamp at a ref, read at the ref's COMMIT rather than at the ref itself. Returns the sha
// alongside so a caller (and the test) can prove which object was read.
export function versionAtRef(git, ref, path) {
  const commit = resolveCommit(git, ref);
  if (!commit) return { commit: null, version: null };
  return { commit, version: readFileAtRef(git, commit, path) };
}

// Every `vX.Y.Z` tag in the repo, aliases excluded.
export function listReleaseTags(git) {
  const out = attempt(git, ["tag", "--list", "v*"]);
  if (!out) return [];
  return out.split("\n").map((s) => s.trim()).filter((t) => RELEASE_TAG.test(t));
}

// Commits `to` is ahead of `from`. Null when either ref is missing, so an absent alias reports
// nothing rather than a fabricated zero.
export function commitDistance(git, from, to) {
  const out = attempt(git, ["rev-list", "--count", `${from}..${to}`]);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

// Gather everything `checkRelease` needs from a real (or fixture) repo.
//
// `tag` is the ref the caller was handed — `GITHUB_REF_NAME`, which on a push to main is
// literally "main". Choosing the tag under scrutiny is decided HERE, not in YAML: use the given
// name when it names a release, otherwise fall back to the highest release tag, so every push
// re-checks the newest published stamp. Keeping this in the module is deliberate — the four
// tasks before this one all had criteria reachable only by running a workflow, because their
// logic lived in inline shell.
export function collectFacts({
  git,
  tag = "",
  mainRef = "HEAD",        // the ref actually READ — "HEAD" in CI, which is the pushed main commit
  mainLabel = "main",      // what the messages CALL it; a sha in a human-facing warning helps nobody
  aliasRef = null,
  rootPath = ROOT_VERSION_PATH,
  templatePath = TEMPLATE_VERSION_PATH,
} = {}) {
  const rootVersion = readFileAtRef(git, mainRef, rootPath);
  const templateVersion = readFileAtRef(git, mainRef, templatePath);

  const latestReleaseTag = highestReleaseTag(listReleaseTags(git));
  const subject = RELEASE_TAG.test(tag) ? tag : latestReleaseTag;

  const subjectRead = subject ? versionAtRef(git, subject, rootPath) : { commit: null, version: null };
  const latestRead = !latestReleaseTag
    ? { commit: null, version: null }
    : latestReleaseTag === subject
      ? subjectRead
      : versionAtRef(git, latestReleaseTag, rootPath);

  const alias = aliasRef ?? aliasForVersion(rootVersion);

  // A distance we could not measure (missing ref) reports as 0, i.e. nothing to warn about.
  // Erring quiet is right for the two warnings: neither is a failure, and a fabricated number
  // in a release log is worse than no number.
  const distance = (from) => (from ? commitDistance(git, from, mainRef) ?? 0 : 0);

  return {
    tag: subject ?? "",
    tagCommit: subjectRead.commit,
    tagVersion: subjectRead.version,
    rootVersion,
    templateVersion,
    rootPath,
    templatePath,
    latestReleaseTag,
    latestReleaseVersion: latestRead.version,
    mainAhead: distance(latestReleaseTag),
    mainRef: mainLabel,
    aliasRef: alias,
    aliasBehind: distance(alias),
  };
}

// Collect, then judge. The one call a CLI needs.
export function runReleaseGuard(options = {}) {
  const facts = collectFacts(options);
  return { facts, ...checkRelease(facts) };
}

// Render a verdict as lines. GitHub picks up `::error::` / `::warning::`; a plain terminal just
// reads them. Kept separate from the CLI so the wording is assertable without spawning.
export function formatReport({ facts, problems, warnings }) {
  const lines = [];
  const subject = facts?.tag ? facts.tag : "<no release tag>";
  lines.push(
    `release-guard: ${subject}` +
    (facts?.tagCommit ? ` (${facts.tagCommit.slice(0, 7)})` : "") +
    ` — ${problems.length} problem(s), ${warnings.length} warning(s)`,
  );
  for (const w of warnings) lines.push(`::warning::release-guard: ${w}`);
  for (const p of problems) lines.push(`::error::release-guard: ${p}`);
  if (!problems.length && !warnings.length) lines.push("  stamps agree with the tree they stamp");
  return lines;
}

// ── CLI ── argument passing only; every decision above is in an exported, tested function.
export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Shared by this CLI and canonical's adapter: print the report and exit on problems.
export function reportAndExit(verdict, { json = false, log = console.log, exit = process.exit } = {}) {
  if (json) log(JSON.stringify(verdict, null, 2));
  else for (const line of formatReport(verdict)) log(line);
  exit(verdict.problems.length ? 1 : 0);
}

if (__isMain) {
  const f = parseFlags(process.argv.slice(2));
  const repo = typeof f.repo === "string" ? f.repo : process.cwd();
  reportAndExit(runReleaseGuard({
    git: makeGitRunner(repo),
    tag: typeof f.tag === "string" ? f.tag : (process.env.GITHUB_REF_NAME || ""),
    mainRef: typeof f.main === "string" ? f.main : "HEAD",
    aliasRef: typeof f.alias === "string" ? f.alias : null,
    rootPath: typeof f["root-path"] === "string" ? f["root-path"] : ROOT_VERSION_PATH,
    templatePath: typeof f["template-path"] === "string" ? f["template-path"] : TEMPLATE_VERSION_PATH,
  }), { json: f.json === true });
}
