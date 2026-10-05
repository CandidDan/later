#!/usr/bin/env node
// review-guide.mjs — the one comment that tells a human where to look (flow-0084).
//
// The human's merge touchpoint is the weak one. A worker's PR description is written by the
// context that produced the work, which makes it the wrong author for "here is what to check":
// it steers away from its own weak spots without meaning to. The three Definition-of-Done
// reviewers already run outside that session, and each posts its own comment — but three comments
// plus a long PR description is not a touchpoint, it is reading.
//
// So a fourth job runs after them and posts ONE comment, updated in place. This file is the
// deterministic half of it, and the split is the whole design:
//
//   FACTS RENDER FROM CODE. The hotspots — a security-trigger path in the diff, a deleted or
//   weakened test file, a file outside the task's declared `touches` — and the three verdicts are
//   computed here, from the diff and the plan's own output. No model is involved and none can
//   edit them. `selectLookHere` lets a model REORDER them and nothing else: it cannot add one,
//   cannot drop one, and cannot reword one, because the text it would reword is produced below
//   and the model only ever names ids.
//
//   PROSE RENDERS FROM THE MODEL. The TL;DR and the smoke-test suggestion, in their own sections.
//   If the call fails, those sections say so and every fact still posts. Fail-open for prose,
//   never for facts — a comment that vanishes because a model call timed out is a touchpoint that
//   is absent exactly when the PR is unusual.
//
// WHY A MARKER AND NOT A NEW COMMENT. One comment per PR, found by `GUIDE_MARKER` and updated.
// The review workflow runs again on every `ready_for_review`, and a guide that appended would
// bury the reviewers' own comments under its history — the opposite of the problem it was built
// for.
//
// Zero dependencies, Node >= 18, same as flow-review.mjs and for the same reason: the
// `flow-tooling` gate job runs `node --test .flow/bin/*.test.mjs` with no install step in front
// of it.
//
//   node .flow/bin/review-guide.mjs facts
//   node .flow/bin/review-guide.mjs comment
//   node .flow/bin/review-guide.mjs comment-id <comments.json>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { checkTouches, parseTouches } from "./touches-guard.mjs";
import {
  SECURITY_FLOOR_PATHS,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  oneLine,
  parseReviewConfig,
  securityDecision,
} from "./flow-review.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reached
// through a symlink they differ, the CLI block never runs, and the guide job exits 0 having
// written nothing — no comment, no error, a green tick. See main-module.test.mjs.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// The hidden marker that makes the comment findable. An HTML comment, so it renders as nothing,
// and specific enough that it cannot collide with a reviewer's own comment. Pinned by a test:
// changing it orphans every existing guide comment in the fleet, which is a decision, not a tidy.
export const GUIDE_MARKER = "<!-- flow-review-guide: do not remove, this is how the guide finds itself -->";

// What the prose sections say when the model call produced nothing usable. It names the fact that
// the facts are unaffected, because a reader who sees one section fail has no way to tell how far
// the failure spread.
export const PROSE_UNAVAILABLE =
  "_Summary unavailable — the model call that writes this section did not return usable output. " +
  "Everything below is computed in code and is unaffected._";

// The PR-description section the guide quotes verbatim, and what it says when there is none.
export const ASSUMPTIONS_HEADING = "## Assumptions";
export const NO_ASSUMPTIONS = "none stated";

// How many hotspots "Look here" shows. The rest are counted, never dropped silently: a list that
// quietly ends at three reads as "three things were wrong".
export const LOOK_HERE_MAX = 3;

// The order hotspots rank in when nothing reorders them, strongest signal first. Stated as data so
// the reason is readable and the test can assert the order rather than infer it:
//   · `tests`    — a deleted test file or a net loss of assertions. NOTHING else on the PR blocks
//                  on this. qa checks that every criterion has a proving test; it does not notice
//                  that an unrelated test got quietly weaker in the same diff.
//   · `touches`  — a file outside the task's declared blast radius. touches-guard already fails
//                  the PR for this, so the check is red; what the human needs is WHICH file.
//   · `security` — a path that triggered (or would have triggered) the security review. Ranked
//                  last of the three because a reviewer has already read it and said so.
export const HOTSPOT_KINDS = Object.freeze(["tests", "touches", "security"]);

export class GuideError extends Error {}

// ── the PR description's assumptions ──────────────────────────────────────────────────────
// Quoted VERBATIM, never summarised. The point of the section is that it is the author's own
// statement of what they decided without asking; a paraphrase of that is a second guess.
//
// The heading match is deliberately loose about level (`##`/`###`) and trailing punctuation,
// because the PR description is hand-written and a template drifts. It is strict about the
// section ENDING at the next heading of the same or a higher level, so a long description does
// not drag its remaining sections into the quote.
export function assumptionsSection(body) {
  const src = String(body ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*assumptions\b\s*:?\s*$/i.test(l.trim()));
  if (start === -1) return { stated: false, text: NO_ASSUMPTIONS };
  const level = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+\S/);
    if (heading && heading[1].length <= level) break;
    out.push(lines[i]);
  }
  const text = out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  // A heading with nothing under it is not a statement of assumptions. Reporting it as one would
  // render an empty blockquote and read as "the author said nothing deliberately".
  return text ? { stated: true, text } : { stated: false, text: NO_ASSUMPTIONS };
}

// ── test files, deleted or weakened ───────────────────────────────────────────────────────
// Language-agnostic by shape, because the guide ships to every repo that adopts Flow and the
// test-file conventions differ: a path segment or a filename stem of `test`/`tests`/`spec`, in
// any of the usual spellings.
const TEST_PATH_RE = /(^|\/)(tests?|specs?|__tests__)(\/|$)|(^|[\/._-])(test|spec)s?\.[A-Za-z0-9]+$|(^|\/)test_[^/]+$/i;

export function isTestFile(path) {
  return TEST_PATH_RE.test(String(path ?? ""));
}

// An assertion, by shape rather than by framework. `assert`, `expect`, `should`, `t.is`, `require`
// (Python's unittest `assertX` is covered by `assert`), Go's `if got != want`-style `t.Error`/
// `t.Fatal`. A line that merely calls the code under test is not an assertion, which is the
// distinction that makes a net count mean something.
const ASSERTION_RE = /\b(assert\w*|expect|should|t\.(is|ok|not|deepEqual|Error\w*|Fatal\w*)|XCTAssert\w*)\b/;

// Every file the patch touches, with its change kind and its assertion delta. The parse is a
// shape parse of `git diff` output: `diff --git a/X b/X` opens a file, `deleted file mode` marks
// a deletion, and inside hunks `-`/`+` lines are the removals and additions. Deliberately not a
// full patch parser — it reads only what the facts below are computed from.
export function parseDiffFiles(diff) {
  const files = new Map();
  let current = null;
  let inHunk = false;
  for (const raw of String(diff ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const header = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2], deleted: false, added: false, removedAssertions: 0, addedAssertions: 0 };
      files.set(current.path, current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (/^deleted file mode /.test(raw)) { current.deleted = true; continue; }
    if (/^new file mode /.test(raw)) { current.added = true; continue; }
    if (/^@@ /.test(raw)) { inHunk = true; continue; }
    if (!inHunk) continue;
    // `---`/`+++` are the file-name lines, never content, and a diff of a diff would otherwise
    // count them. Checked before the single-character tests so the order cannot be reversed.
    if (/^(\+\+\+|---) /.test(raw)) continue;
    if (raw.startsWith("-") && ASSERTION_RE.test(raw.slice(1))) current.removedAssertions++;
    else if (raw.startsWith("+") && ASSERTION_RE.test(raw.slice(1))) current.addedAssertions++;
  }
  return [...files.values()];
}

// The test-coverage facts: files deleted outright, and files that ended the diff with fewer
// assertions than they started it with. A NET decrease is sufficient, deliberately — a rewrite
// that swaps one assertion for another nets zero and is not a hotspot, while three removed for
// one added is, whatever the commit message says about refactoring.
export function testChanges(diff) {
  const deleted = [];
  const weakened = [];
  for (const f of parseDiffFiles(diff)) {
    if (!isTestFile(f.path)) continue;
    if (f.deleted) { deleted.push(f.path); continue; }
    const net = f.removedAssertions - f.addedAssertions;
    if (net > 0) weakened.push({ file: f.path, removed: f.removedAssertions, added: f.addedAssertions, net });
  }
  return { deleted, weakened };
}

// ── the task's declared blast radius ──────────────────────────────────────────────────────
// `task.md` is the gate's own artefact: the task file's bytes, behind a one-line HTML comment
// recording where it was resolved from — or a sentinel, when the PR has no task. Strip the comment
// before parsing so `parseTouches` sees real frontmatter at the top of the string, and report
// "nothing declared" rather than guessing: `checkTouches` with an empty glob list calls EVERY file
// out of scope, which on a task-less PR would fill "Look here" with the whole diff.
export function touchesFromTaskContext(text) {
  const src = String(text ?? "").replace(/^<!--[\s\S]*?-->\n/, "");
  const touches = parseTouches(src);
  return { touches, declared: touches.length > 0 };
}

// ── the facts ─────────────────────────────────────────────────────────────────────────────
// Everything "Look here" can possibly say, computed once. `securityDecision` is IMPORTED rather
// than re-derived: it is the function that decided whether the security review ran at all, and a
// guide that applied its own reading of `security_paths` would point a human at a different set
// of files than the check they are reading the verdict of.
export function computeFacts({
  changedFiles = [],
  diff = "",
  taskContext = "",
  prBody = "",
  securityPaths = [],
  taskId = "",
} = {}) {
  const files = changedFiles.filter(Boolean);
  const decision = securityDecision({ changedFiles: files, securityPaths });
  const { touches, declared } = touchesFromTaskContext(taskContext);
  const outside = declared ? checkTouches({ changedFiles: files, touches }).outside : [];
  return {
    taskId: String(taskId ?? ""),
    changedCount: files.length,
    security: { matched: decision.matched, floor: decision.floor },
    tests: testChanges(diff),
    touches: { declared, globs: touches, outside },
    assumptions: assumptionsSection(prBody),
  };
}

// The hotspots, as `{ id, kind, text }`, in `HOTSPOT_KINDS` order. One entry per FILE rather than
// one per category, because "three things to look at" is only useful if each names a place.
export function rankHotspots(facts) {
  const out = [];
  const push = (kind, id, text) => out.push({ id: `${kind}:${id}`, kind, text });

  for (const file of facts.tests?.deleted ?? []) {
    push("tests", file, `\`${file}\` — **test file deleted.** Nothing else on this PR blocks on a test that stopped existing.`);
  }
  for (const w of facts.tests?.weakened ?? []) {
    push("tests", w.file,
      `\`${w.file}\` — **${w.net} assertion${w.net === 1 ? "" : "s"} removed on net** ` +
      `(${w.removed} removed, ${w.added} added). The file still runs; it proves less.`);
  }
  for (const file of facts.touches?.outside ?? []) {
    push("touches", file,
      `\`${file}\` — changed, but **outside the task's declared \`touches\`**. Either the scope ` +
      `grew without the task saying so, or the task's globs are wrong.`);
  }
  // The floor is reported as the floor, and a configured match as a configured match, for the same
  // reason `securityDecision` separates them: one invites tuning `security_paths`, the other says
  // there is nothing to tune. A file in both is listed once, under the floor.
  const floor = new Set(facts.security?.floor ?? []);
  for (const file of floor) {
    push("security", file,
      `\`${file}\` — matches the **always-reviewed security floor** ` +
      `(${SECURITY_FLOOR_PATHS.join(", ")}): it decides what the gates themselves do.`);
  }
  for (const file of facts.security?.matched ?? []) {
    if (floor.has(file)) continue;
    push("security", file, `\`${file}\` — matches this repo's **\`review.security_paths\`**.`);
  }
  return out;
}

// What the model is allowed to change about "Look here": the ORDER, and only the order.
//
// `modelIds` is a list of hotspot ids. Ids it does not recognise are ignored (the model invented
// one), ids it omits keep their computed rank behind the ones it named (the model dropped one).
// So no fact can be added, removed or reworded — `shown` is always a prefix of a permutation of
// `hotspots`, and every `text` is the one `rankHotspots` wrote.
export function selectLookHere(hotspots, modelIds = [], max = LOOK_HERE_MAX) {
  const list = [...(hotspots ?? [])];
  const wanted = (modelIds ?? []).map((v) => String(v));
  const rank = (h) => {
    const at = wanted.indexOf(h.id);
    return at === -1 ? wanted.length : at;
  };
  const ordered = list
    .map((h, i) => ({ h, i }))
    .sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i)
    .map(({ h }) => h);
  return { shown: ordered.slice(0, max), remaining: Math.max(0, ordered.length - max) };
}

// ── the verdicts row ──────────────────────────────────────────────────────────────────────
// Built from the three jobs' RESULTS, not from their verdict files: each reviewer writes its JSON
// into its own job's workspace, and nothing downstream can read it. A job result is the same fact
// the human sees on the checks list, which is the point — the guide must never disagree with it.
const RESULT_TEXT = {
  success: ":white_check_mark: pass",
  failure: ":x: fail",
  cancelled: ":black_square_button: cancelled",
  skipped: ":fast_forward: did not run",
};

export function verdictRows({
  qa = "", codeReview = "", security = "", securityRun = "", securityReason = "",
} = {}) {
  const cell = (result) => RESULT_TEXT[String(result)] ?? `:grey_question: unknown (\`${String(result) || "no result"}\`)`;
  const rows = [
    { check: "qa", verdict: cell(qa) },
    { check: "code-review", verdict: cell(codeReview) },
  ];
  // The security job ALWAYS runs so the check is never silently absent — which means a skipped
  // REVIEW still reports a successful JOB. Rendering that as "pass" is the one wrong answer this
  // row can give, so the skip is decided from the plan's own `security_run`, and carries the
  // reason the plan gave for it.
  rows.push(String(securityRun) === "true"
    ? { check: "security", verdict: cell(security) }
    : { check: "security", verdict: ":fast_forward: **skipped** — not a security-triggering diff", note: String(securityReason ?? "").trim() });
  return rows;
}

// ── the model's half ──────────────────────────────────────────────────────────────────────
// Tolerant of a fence (models add them by habit) and of a missing field, strict about nothing
// else. Throwing is a normal outcome here, not a failure: the caller renders the fail-open comment.
export function parseProse(src) {
  const text = String(src ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!text) throw new GuideError("the model wrote no prose");
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new GuideError(`the model's prose is not JSON: ${e.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GuideError("the model's prose is not a JSON object");
  }
  const line = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  return {
    tldr: line(parsed.tldr),
    smokeTest: line(parsed.smoke_test ?? parsed.smokeTest),
    lookHere: Array.isArray(parsed.look_here ?? parsed.lookHere)
      ? (parsed.look_here ?? parsed.lookHere).map((v) => String(v))
      : [],
  };
}

// The model-facing brief: the facts, and the ids it may name. It reads this file and nothing else
// about the diff, which is what keeps the guide's cost flat.
//
// The PR description's assumptions are fenced. They are chosen by whoever opened the PR, and the
// model's output is rendered into a comment on that same PR — so an "Assumptions" section shaped
// like instructions is a prompt-injection surface with a real target. Same fence, and the same
// reason, as `flow-review.mjs`'s untrusted block around the branch name and the PR title.
export function factsBrief(facts, hotspots) {
  const out = [
    "# Review guide — the computed facts",
    "",
    `Task: \`${facts.taskId || "none resolved"}\` · changed files: ${facts.changedCount}`,
    "",
    "## Hotspots (these are the ids you may name in `look_here`)",
    "",
  ];
  if (hotspots.length) for (const h of hotspots) out.push(`- \`${h.id}\` — ${h.text}`);
  else out.push("- none. The diff touches no security path, deletes or weakens no test, and stays inside the task's `touches`.");
  out.push("", "## Assumptions stated in the PR description", "");
  if (facts.assumptions.stated) {
    // ONE line, as a JSON string literal through `oneLine` — the same encoding flow-review.mjs
    // uses for the branch and title, and for the same reason: a raw multi-line paste would let a
    // PR body forge the END line and walk out of the fence (code review on #158). The human-facing
    // comment below still quotes the text verbatim; only the model-facing brief is encoded.
    out.push(UNTRUSTED_BEGIN, oneLine(facts.assumptions.text), UNTRUSTED_END);
  } else {
    out.push(NO_ASSUMPTIONS);
  }
  return out.join("\n") + "\n";
}

// ── the comment ───────────────────────────────────────────────────────────────────────────
// Fixed order: TL;DR · Look here · Assumptions · Smoke test · Verdicts. Fixed because flow-0082
// is meant to reuse this comment as its escalation card, and because a human scanning it on a
// phone should find the same thing in the same place on every PR.
export function guideComment({ facts, hotspots, prose = null, verdicts = [] } = {}) {
  const { shown, remaining } = selectLookHere(hotspots, prose?.lookHere ?? []);
  const out = [GUIDE_MARKER, "", "## Where to look", ""];

  out.push(prose?.tldr ? `**TL;DR** — ${prose.tldr}` : PROSE_UNAVAILABLE, "");

  out.push("### Look here", "");
  if (shown.length) {
    for (const h of shown) out.push(`1. ${h.text}`);
    if (remaining) out.push("", `*…and ${remaining} more computed hotspot${remaining === 1 ? "" : "s"}, not shown here.*`);
  } else {
    out.push("*Nothing computed stands out: no security-trigger path in the diff, no test deleted " +
      "or weakened, nothing outside the task's declared `touches`.*");
  }
  out.push("");

  out.push("### Assumptions", "");
  if (facts.assumptions.stated) {
    for (const line of facts.assumptions.text.split("\n")) out.push(line ? `> ${line}` : ">");
  } else {
    out.push(`*${NO_ASSUMPTIONS}* — the PR description carries no \`${ASSUMPTIONS_HEADING}\` section.`);
  }
  out.push("");

  out.push("### Smoke test", "");
  out.push(prose?.smokeTest ? prose.smokeTest : PROSE_UNAVAILABLE, "");

  out.push("### Verdicts", "", "| check | verdict |", "| --- | --- |");
  for (const row of verdicts) out.push(`| \`${row.check}\` | ${row.verdict} |`);
  const notes = verdicts.filter((r) => r.note);
  if (notes.length) {
    out.push("");
    for (const row of notes) out.push(`- \`${row.check}\`: ${row.note}`);
  }

  out.push("", "---", "",
    "*The hotspots, the assumptions quote and the verdicts above are computed in code " +
    "(`.flow/bin/review-guide.mjs`); only the TL;DR and the smoke test are written by a model, " +
    "which cannot add, drop or reword a fact. This comment is updated in place, never reposted.*");
  return out.join("\n") + "\n";
}

// The existing guide comment in a PR's comment list, or null. Marker-based, so it survives an
// edited body and does not depend on who posted it — and it takes the OLDEST match, so a
// duplicate created by some earlier run keeps being the one updated rather than the pair growing.
//
// `flat()` is not defensive tidying. The workflow fetches the list with `gh api --paginate
// --slurp`, and gh's two shapes for that — one merged array, or one array per page — differ by gh
// version. Reading the nested shape as "no previous comment" would post a NEW comment on every run
// of every PR in the fleet, which is the one failure this function exists to prevent, arriving
// through a dependency nobody pinned.
export function pickGuideComment(comments, marker = GUIDE_MARKER) {
  const list = Array.isArray(comments) ? comments.flat() : [];
  const matches = list.filter((c) => typeof c?.body === "string" && c.body.includes(marker));
  if (!matches.length) return null;
  return matches.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b));
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
// Three subcommands, split where the shell has to take over: `facts` before the model call,
// `comment` after it, and `comment-id` so the upsert decision is code with a test rather than a
// `jq` expression in a workflow nobody can test.
export function runGuideCli(argv, {
  env = process.env,
  configPath = ".flow/config.yml",
  outDir = ".flow-review",
  read = (p) => readFileSync(p, "utf8"),
  write = (p, text) => writeFileSync(p, text),
  log = console.log,
  err = console.error,
} = {}) {
  const [cmd, ...rest] = argv;
  const dir = env.REVIEW_OUT_DIR || outDir;
  const at = (name) => join(dir, name);
  try {
    if (cmd === "facts") {
      const cfgPath = env.FLOW_CONFIG || configPath;
      // The guide's hotspots must agree with the check the human is reading. `security_paths` is
      // therefore read from the same place the security decision was: BASE's config, which the
      // workflow points FLOW_CONFIG at. A PR cannot delete the glob that names its own hotspot.
      const cfg = existsSync(cfgPath) ? parseReviewConfig(read(cfgPath)) : { securityPaths: [] };
      const changedFiles = existsSync(at("files.txt"))
        ? read(at("files.txt")).split("\n").map((s) => s.trim()).filter(Boolean)
        : [];
      const facts = computeFacts({
        changedFiles,
        diff: existsSync(at("diff.patch")) ? read(at("diff.patch")) : "",
        taskContext: existsSync(at("task.md")) ? read(at("task.md")) : "",
        prBody: env.PR_BODY || "",
        securityPaths: cfg.securityPaths,
        taskId: env.TASK_ID || "",
      });
      const hotspots = rankHotspots(facts);
      mkdirSync(dir, { recursive: true });
      write(at("guide-facts.json"), JSON.stringify({ facts, hotspots }, null, 2) + "\n");
      write(at("guide-facts.md"), factsBrief(facts, hotspots));
      log(`review-guide: ${hotspots.length} hotspot(s) across ${facts.changedCount} changed file(s)` +
        `${facts.assumptions.stated ? ", assumptions stated" : ", no assumptions stated"}`);
      return 0;
    }

    if (cmd === "comment") {
      if (!existsSync(at("guide-facts.json"))) {
        throw new GuideError(`no computed facts at ${at("guide-facts.json")} — run \`facts\` first`);
      }
      const { facts, hotspots } = JSON.parse(read(at("guide-facts.json")));
      // FAIL-OPEN FOR PROSE ONLY. Every branch below still renders the facts and the verdicts;
      // the model's absence costs two sections and a line saying so.
      let prose = null;
      try {
        prose = parseProse(existsSync(at("guide-prose.json")) ? read(at("guide-prose.json")) : "");
      } catch (e) {
        err(`::warning::review-guide: ${e.message}. Posting the computed facts and verdicts without a summary.`);
      }
      const verdicts = verdictRows({
        qa: env.QA_RESULT, codeReview: env.CODE_REVIEW_RESULT, security: env.SECURITY_RESULT,
        securityRun: env.SECURITY_RUN, securityReason: env.SECURITY_REASON,
      });
      const body = guideComment({ facts, hotspots, prose, verdicts });
      mkdirSync(dir, { recursive: true });
      write(at("guide-comment.md"), body);
      log(body);
      return 0;
    }

    if (cmd === "comment-id") {
      const [file] = rest;
      if (!file) throw new GuideError("usage: review-guide.mjs comment-id <comments.json>");
      // No comments file is not an error: a PR with no comments has no guide to update, and the
      // caller treats empty output as "post a new one".
      const raw = existsSync(file) ? read(file) : "[]";
      let parsed;
      try { parsed = JSON.parse(raw || "[]"); } catch (e) {
        throw new GuideError(`${file} is not JSON (${e.message}) — the comment list could not be read`);
      }
      const found = pickGuideComment(parsed);
      log(found ? String(found.id) : "");
      return 0;
    }

    throw new GuideError(
      `unknown command ${JSON.stringify(cmd ?? "")} — expected "facts", "comment" or "comment-id"`);
  } catch (e) {
    // The guide is advisory and never blocks, but a guide that broke must say so rather than
    // leaving a green tick over a missing comment.
    err(`::error::review-guide: ${e.message}`);
    return 1;
  }
}

if (__isMain) process.exit(runGuideCli(process.argv.slice(2)));
