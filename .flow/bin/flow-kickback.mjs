#!/usr/bin/env node
// flow-kickback.mjs — the decision logic behind the bounded auto-fix round (flow-0082).
//
// WHAT THIS IS FOR. The three Definition-of-Done reviewers run as checks on the PR
// (`_flow-review.yml`, flow-0007). When qa or code-review fails, the protocol calls that a
// kickback: address it on the same branch, re-run the gate, re-request review. Nothing
// dispatched that work — the worker's session ended at `gh pr ready`, and the queue runner only
// picks `ready` tasks — so an `in_review` task with a red check sat until a human noticed. The
// human was a relay carrying a finding that already named the file, the line and the fix.
//
// `_flow-kickback.yml` automates that relay. This file is the half of it that DECIDES, kept out
// of YAML on purpose: a decision expressed in `if:` expressions is a decision with no unit tests
// and no reason string. The workflow gathers facts and acts on results; every judgment below is
// a pure function over plain data.
//
// THE BOUNDS ARE THE SUBSTANCE, not decoration. The fixer and the reviewer are both models, and
// more rounds between them can converge on something wrong as easily as something right. So:
//
//   · off by default (`review.auto_fix_rounds` absent or 0), and gated on FLOW_AI like every
//     other AI workflow;
//   · a round cap, clamped to a HARD MAX of 3 — do not raise that without going back to the
//     human;
//   · security failures are NEVER auto-fixed;
//   · a round that deletes a test or removes an assertion escalates instead of pushing, because
//     the cheapest way to satisfy "criterion X has no proving test" is to weaken the test;
//   · every escalation is ONE decision card, not a label pointing at a PR to dig through.
//
// Zero dependencies (Node >= 18). Everything here is pure except the CLI block at the bottom.

import { realpathSync as __realpathSync, appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { reviewBlock } from "./flow-review.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// Reached through a symlink the CLI block never runs: no output, exit 0, nothing to debug.
// Compare realpaths on both sides. See parse-task-id.mjs for the full account.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// ── constants ────────────────────────────────────────────────────────────────────────────

// The ceiling on `review.auto_fix_rounds`, whatever a repo configures. Three rounds is already
// two more conversations than a human would have had before reading the PR themselves.
export const HARD_MAX_ROUNDS = 3;

// The git trailer every pushed round carries, stamped by the WORKFLOW (never by the fixer), so
// the round history lives on the PR it belongs to rather than in notes committed to the default
// branch.
export const ROUND_TRAILER = "Flow-Auto-Fix-Round";

// The escalation label. It is also the off switch for a PR: the workflow never acts on a
// labelled PR, and removing the label re-arms it.
export const NEEDS_HUMAN_LABEL = "flow:needs-human";

// The two checks a round may address. `security` is deliberately absent.
export const AUTO_FIXABLE_CHECKS = Object.freeze(["qa", "code-review"]);
export const SECURITY_CHECK = "security";

// The rendered decision card's budget, in characters. A card read on a phone is the point.
export const CARD_MAX_CHARS = 1500;

// The task status a PR must be at for a round to be dispatched.
export const REVIEWABLE_STATUS = "in_review";

// The record separator between commit messages in the file the workflow hands `rounds`/`decide`.
// A commit message contains newlines and blank lines by definition, so newline-delimiting them
// would merge two messages into one and turn a body mention into a trailer.
//
// Written as the ESCAPE `\0`, never as a literal NUL byte: git classifies any file containing one
// as binary, which costs this file its diff and its line comments in every review of it.
export const MESSAGE_SEPARATOR = "\0";

// ── review.auto_fix_rounds ───────────────────────────────────────────────────────────────

// `review.auto_fix_rounds` as written, or null when the key is absent. Deliberately distinct
// facts: "this repo chose 0" and "this repo chose nothing" both mean off, but only one of them
// is a decision, and `effectiveCap` is the single place allowed to collapse them.
export function parseAutoFixRounds(src) {
  const block = reviewBlock(src);
  if (block === null) return null;
  const m = block.match(/^[ \t]*auto_fix_rounds:[ \t]*(\S.*)$/m);
  if (!m) return null;
  const raw = m[1].trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
  return raw === "" ? null : raw;
}

// The cap actually in force, plus the warning a human needs when it differs from what was asked
// for. A value above the hard max is CLAMPED rather than refused: the repo has said it wants
// auto-fix, and refusing outright would silently switch it off.
export function effectiveCap(configured) {
  if (configured === null || configured === undefined || configured === "") {
    return { cap: 0, configured: null, warning: "" };
  }
  const n = Number(configured);
  if (!Number.isInteger(n) || n < 0) {
    return {
      cap: 0,
      configured,
      warning:
        `review.auto_fix_rounds is "${configured}", which is not a whole number of rounds — ` +
        `auto-fix is OFF. Set it to a value from 0 to ${HARD_MAX_ROUNDS}, or remove the key.`,
    };
  }
  if (n > HARD_MAX_ROUNDS) {
    return {
      cap: HARD_MAX_ROUNDS,
      configured: n,
      warning:
        `review.auto_fix_rounds is configured as ${n}; the hard maximum is ${HARD_MAX_ROUNDS}, ` +
        `so ${HARD_MAX_ROUNDS} is in force. The fixer and the reviewer are both models, and more ` +
        `rounds between them converge on agreement, not necessarily on correctness.`,
    };
  }
  return { cap: n, configured: n, warning: "" };
}

// ── countRounds ──────────────────────────────────────────────────────────────────────────

// A git trailer line: `Key: value`, the key a letter-led token of letters, digits and dashes.
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]/;
// The round trailer, well-formed: `Flow-Auto-Fix-Round: 2/3`, nothing else on the line.
const ROUND_TRAILER_LINE = new RegExp(`^${ROUND_TRAILER}:[ \\t]*(\\d+)/(\\d+)[ \\t]*$`);

// The trailer block of one commit message: the last paragraph, when every one of its lines is a
// trailer AND something precedes it. A message that is nothing but trailers has no subject and
// is not a commit this system writes, so it does not count — the same conservative direction
// every other guard here takes.
export function trailerBlock(message) {
  const lines = String(message ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return [];
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  if (start === 0) return [];                                  // no subject above the block
  const block = lines.slice(start);
  if (!block.every((l) => TRAILER_LINE.test(l))) return [];
  return block;
}

// How many of `messages` carry a well-formed round trailer. Pure, so the workflow can hand it
// `gh api repos/{owner}/{repo}/pulls/{n}/commits` output and get the count the cap is read
// against. The count lives on the PR, never on the default branch: that removes this workflow's
// only need for write access there, and keeps a PR's round history with the PR.
//
// KNOWN LIMIT, ACCEPTED: a human who squashes or rewrites the branch resets the count. That is
// a human act, and the cap exists to bound the machine.
export function countRounds(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => trailerBlock(m).some((l) => ROUND_TRAILER_LINE.test(l))).length;
}

// The trailer a round stamps. `cap` is carried so the PR's own history says what the bound was
// at the time, rather than only what it is now.
export const roundTrailer = (round, cap) => `${ROUND_TRAILER}: ${round}/${cap}`;

// ── weakensTests ─────────────────────────────────────────────────────────────────────────

// Does this path hold tests? Name conventions first, then directory conventions.
export function isTestPath(path) {
  if (!path) return false;
  const p = String(path).replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.[A-Za-z0-9]+$/.test(base)) return true;
  if (/_test\.[A-Za-z0-9]+$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base)) return true;
  return p.split("/").slice(0, -1)
    .some((seg) => seg === "test" || seg === "tests" || seg === "__tests__");
}

// A line that DECLARES a test. The JS forms allow a `.each`/`.skip` suffix so a removed
// `test.each(` still reads as a declaration.
const DECLARES_TEST = /(^|[^\w.$])(test|it|describe)\s*[.(]|^\s*def\s+test_/;
// A line that ASSERTS something.
const ASSERTS = /\bassert|\bexpect\s*\(|\.should\b/;
// Added markers that switch a test off or soften it.
const SKIP_MARKER = /\.skip\b|\.only\b|\bskip\s*:|\btodo\s*:/;

// Does this unified diff weaken the tests? Returns the offending lines — each with its file, the
// line itself and a reason — so the decision card can name them. Empty means clean.
//
// A trip is any of:
//   1. a test file deleted or renamed;
//   2. a removed line, in a test file, that declares a test;
//   3. a removed line, in a test file, that contains an assertion;
//   4. an added `.skip` / `.only` / `skip:` / `todo:` in a test file.
//
// ANY REMOVED ASSERTION COUNTS, even when the same edit adds a replacement. That is conservative
// on purpose. Adding an assertion is always allowed; a rewrite that really is stronger costs a
// human one tap on the decision card. A loosened assertion that slipped through would cost a
// gate that lies, which is the one failure this whole mechanism cannot afford.
//
// KNOWN LIMIT, STATED RATHER THAN HIDDEN: this is a line heuristic. A weakening that touches no
// declaration and no assertion line — a changed fixture that makes an existing assertion
// trivially true, say — is not caught here. That is qa's job on the re-review.
export function weakensTests(diff) {
  const lines = String(diff ?? "").replace(/\r\n/g, "\n").split("\n");
  const offenders = [];
  let file = "";
  let fileIsTest = false;
  let reportedFileLevel = false;

  const trip = (reason, line) => offenders.push({ file, line, reason });

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = m ? m[2] : raw.slice("diff --git ".length);
      fileIsTest = isTestPath(file) || (m ? isTestPath(m[1]) : false);
      reportedFileLevel = false;
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      if (fileIsTest && !reportedFileLevel) { trip("test file deleted", raw.trim()); reportedFileLevel = true; }
      continue;
    }
    if (raw.startsWith("rename from ") || raw.startsWith("rename to ")) {
      if (fileIsTest && !reportedFileLevel) { trip("test file renamed", raw.trim()); reportedFileLevel = true; }
      continue;
    }
    // `--- a/x` and `+++ b/x` are headers, not content. A `/dev/null` destination is a deletion
    // in a diff produced without `diff --git` headers (a bare `diff -u`).
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      const m = raw.match(/^[+-]{3} (?:[ab]\/)?(.+?)(?:\t.*)?$/);
      const named = m ? m[1] : "";
      if (named && named !== "/dev/null" && !file) { file = named; fileIsTest = isTestPath(named); }
      if (raw.startsWith("+++ ") && named === "/dev/null" && fileIsTest && !reportedFileLevel) {
        trip("test file deleted", raw.trim());
        reportedFileLevel = true;
      }
      continue;
    }
    if (!fileIsTest) continue;
    if (raw.startsWith("-")) {
      const body = raw.slice(1);
      if (DECLARES_TEST.test(body)) trip("removed a test declaration", body.trim());
      else if (ASSERTS.test(body)) trip("removed an assertion", body.trim());
    } else if (raw.startsWith("+")) {
      const body = raw.slice(1);
      if (SKIP_MARKER.test(body)) trip("added a skip/only/todo marker", body.trim());
    }
  }
  return offenders;
}

// One line per offender, for a step summary or a card.
export const weakensReport = (offenders) =>
  offenders.map((o) => `${o.file}: ${o.reason} — ${o.line}`).join("\n");

// ── decide ───────────────────────────────────────────────────────────────────────────────

export const DISPATCH = "dispatch";
export const SKIP = "skip";
export const ESCALATE = "escalate";

const truthy = (v) => v === true || String(v ?? "").toLowerCase() === "true";
const list = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/))
    .map((s) => String(s).trim()).filter(Boolean);

// The whole gate, in order. The FIRST check that applies decides the result, and every result
// carries a one-line reason naming the condition — a skip nobody can explain is a gate nobody
// trusts.
//
// facts:
//   failedChecks  which review jobs failed (`qa`, `code-review`, `security`)
//   draft         is the PR a draft?
//   fork          is the PR from a fork?
//   labels        the PR's labels
//   taskId        the id resolved from the branch or the title, or "" when none resolved
//   taskStatus    that task's status on the default branch
//   rounds        rounds already used (countRounds over the PR's commit messages)
//   configuredCap review.auto_fix_rounds, as configured (null when absent)
//   flowAi        the FLOW_AI repo variable
//   flowPat       is FLOW_PAT present?
export function decide(facts = {}) {
  const failed = list(facts.failedChecks);
  const labels = list(facts.labels);
  const { cap, warning } = effectiveCap(facts.configuredCap ?? null);
  const rounds = Number.isFinite(Number(facts.rounds)) ? Number(facts.rounds) : 0;
  const verdict = (action, reason) =>
    ({ action, reason, cap, rounds, round: rounds + 1, warning, failed });

  // 1. The global AI switch. Same gate as every other workflow that spends model quota.
  if (!truthy(facts.flowAi)) {
    return verdict(SKIP, "FLOW_AI is not 'true' — autonomous work is off in this repo.");
  }

  // 2. Off by default. An adopting repo opts in by setting review.auto_fix_rounds.
  if (cap === 0) {
    return verdict(SKIP,
      `auto-fix off — review.auto_fix_rounds is not set to a round count.${warning ? " " + warning : ""}`);
  }

  // 3. A push made with GITHUB_TOKEN does not trigger workflows, so a fix made without FLOW_PAT
  //    would never be re-reviewed — a round nothing can check is worse than no round.
  if (!truthy(facts.flowPat)) {
    return verdict(SKIP,
      "FLOW_PAT is absent — a fix pushed with GITHUB_TOKEN would never be re-reviewed.");
  }

  // 4. The fork fence, matching _flow-review.yml's. Fork-authored code never runs here.
  if (truthy(facts.fork)) {
    return verdict(SKIP,
      "the PR is from a fork — fork-authored code is never given this workflow's credentials.");
  }

  // 5. No task, no mandate. The acceptance criteria are the standard a round works to.
  const taskId = String(facts.taskId ?? "").trim();
  if (!taskId) {
    return verdict(SKIP,
      "no task id resolves from the branch or the PR title — this PR is not Flow's to fix.");
  }
  const status = String(facts.taskStatus ?? "").trim();
  if (status !== REVIEWABLE_STATUS) {
    return verdict(SKIP,
      `task ${taskId} is '${status || "unknown"}', not '${REVIEWABLE_STATUS}' — nothing is awaiting review.`);
  }

  // 6. The two off switches a human holds on one PR.
  if (truthy(facts.draft)) {
    return verdict(SKIP, "the PR is a draft — it is not asking for review yet.");
  }
  if (labels.includes(NEEDS_HUMAN_LABEL)) {
    return verdict(SKIP,
      `the PR carries '${NEEDS_HUMAN_LABEL}' — a human holds it. Remove the label to re-arm auto-fix.`);
  }

  // 7. Security is never auto-fixed, alone or alongside others.
  if (failed.includes(SECURITY_CHECK)) {
    return verdict(ESCALATE, "the security check failed — a security finding is never auto-fixed.");
  }

  // 8. The cap. Reached, not exceeded, is already the end: round `cap + 1` must not happen.
  if (rounds >= cap) {
    return verdict(ESCALATE,
      `auto-fix rounds exhausted — ${rounds} of ${cap} used and review is still red.`);
  }

  // 9. Something auto-fixable must actually have failed. A green run reaching here is a caller
  //    triggering on the wrong conclusion, and dispatching a fixer at it would burn a round on
  //    nothing.
  const fixable = failed.filter((c) => AUTO_FIXABLE_CHECKS.includes(c));
  if (fixable.length === 0) {
    return verdict(SKIP, `no auto-fixable check failed (failed: ${failed.join(", ") || "none"}).`);
  }
  return verdict(DISPATCH,
    `${fixable.join(" + ")} failed — dispatching auto-fix round ${rounds + 1}/${cap}.`);
}

// ── the decision card ────────────────────────────────────────────────────────────────────

export const CARD_TITLE = "### Flow auto-fix — a human decision is needed";
export const CARD_FALLBACK_TITLE =
  "### Flow auto-fix — a human decision is needed (recommendation unavailable)";
export const MERGE_LINE = "merge as is";
const MISSING = "not captured";

// Is this card input usable? Returns the problems, so the fallback can say WHICH field was
// missing rather than only that something was. Validation is code, not prose in a prompt: the
// model writing the card is the same class of thing as the model that just failed to fix the PR.
export function validateCard(input = {}) {
  const problems = [];
  const text = (k) => (typeof input[k] === "string" ? input[k].trim() : "");
  for (const k of ["finding", "tried", "alternative"]) {
    if (!text(k)) problems.push(`\`${k}\` is missing or empty`);
  }
  const rec = input.recommendation;
  const action = rec && typeof rec === "object" ? String(rec.action ?? "").trim() : "";
  if (action !== "merge" && action !== "kickback") {
    problems.push("`recommendation.action` must be exactly `merge` or `kickback`");
  } else if (action === "kickback" && !String(rec.change ?? "").trim()) {
    problems.push("`recommendation.action` is `kickback` but `recommendation.change` names no change");
  }
  return { ok: problems.length === 0, problems };
}

// Max-min fair allocation of `budget` characters across `texts`, so the rendered card is at most
// CARD_MAX_CHARS whatever a model wrote. Short fields are never cut to make room for a long one.
export function fitFields(texts, budget) {
  const order = Object.keys(texts).sort((a, b) => texts[a].length - texts[b].length);
  const out = {};
  let left = Math.max(0, budget);
  let n = order.length;
  for (const k of order) {
    const share = Math.floor(left / n);
    const value = texts[k];
    if (value.length <= share) { out[k] = value; left -= value.length; }
    else {
      out[k] = share > 1 ? value.slice(0, share - 1).trimEnd() + "…" : "…".slice(0, share);
      left -= out[k].length;
    }
    n--;
  }
  return out;
}

// The one footer line: rounds used out of the cap, the link to the reviewer's own comment (which
// is what a cut field points at), and how to re-arm.
export const cardFooter = (rounds, cap, link) =>
  `Auto-fix rounds used: ${rounds}/${cap} · [the reviewer's full comment](${link}) · ` +
  `re-arm by removing the \`${NEEDS_HUMAN_LABEL}\` label.`;

// ONE comment per escalation, in the G12 shape: the finding, what was tried or disputed, a
// single recommendation, and the alternative it was chosen over. Readable from a phone — a label
// alone is a PR to dig through, which is the problem this replaces.
export function decisionCard(input = {}) {
  const link = String(input.link ?? "").trim().slice(0, 300) || "(no link available)";
  const rounds = Number(input.rounds ?? 0);
  const cap = Number(input.cap ?? 0);
  const check = String(input.check ?? "review").trim() || "review";
  const { ok, problems } = validateCard(input);

  if (!ok) {
    // The fallback renders `tried` as well as `finding`, and that is not symmetry for its own
    // sake. The fallback is what the DEAD-ROUND path reaches: a round that crashed, timed out or
    // handed back unusable JSON has no `finding` of its own, and `cardFromOutcome` puts the
    // guard's own sentence ("the round did not hand back", "it weakened the tests") into
    // `tried`. A fallback that printed only `finding` therefore told the human "not captured"
    // and withheld the one thing the workflow did know — which check fired and why.
    const head = `${CARD_FALLBACK_TITLE}\n\n` +
      `The auto-fix round produced no usable recommendation: ${problems.join("; ")}. ` +
      `Nothing was pushed; this PR is yours to decide.\n\n`;
    const labels = {
      finding: `**Finding** (\`${check}\`): `,
      tried: "\n\n**Tried / disputed:** ",
    };
    const tail = `\n\n---\n${cardFooter(rounds, cap, link)}\n`;
    const overhead =
      head.length + Object.values(labels).reduce((n, s) => n + s.length, 0) + tail.length;
    const parts = fitFields({
      finding: String(input.finding ?? "").trim() || MISSING,
      tried: String(input.tried ?? "").trim() || MISSING,
    }, CARD_MAX_CHARS - overhead);
    return head +
      labels.finding + parts.finding +
      labels.tried + parts.tried +
      tail;
  }

  const action = String(input.recommendation.action).trim();
  const change = String(input.recommendation.change ?? "").trim();
  const labels = {
    finding: `**Finding** (\`${check}\`): `,
    tried: "\n\n**Tried / disputed:** ",
    recommendation: "\n\n**Recommendation:** ",
    alternative: "\n\n**Alternative:** ",
  };
  const head = `${CARD_TITLE}\n\n`;
  const tail = `\n\n---\n${cardFooter(rounds, cap, link)}\n`;
  const overhead =
    head.length + Object.values(labels).reduce((n, s) => n + s.length, 0) + tail.length;
  const parts = fitFields({
    finding: String(input.finding).trim(),
    tried: String(input.tried).trim(),
    recommendation: action === "merge" ? MERGE_LINE : `kick back with: ${change}`,
    alternative: String(input.alternative).trim(),
  }, CARD_MAX_CHARS - overhead);

  return head +
    labels.finding + parts.finding +
    labels.tried + parts.tried +
    labels.recommendation + parts.recommendation +
    labels.alternative + parts.alternative +
    tail;
}

// ── the round's hand-back file ───────────────────────────────────────────────────────────

// Where the fixer hands its outcome back. A directory at the repo root, written by the worker
// and read by the workflow; never committed.
export const OUTCOME_DIR = ".flow-kickback";
export const OUTCOME_FILE = "outcome.json";
export const OUTCOMES = Object.freeze(["fixed", "disputed"]);

// Parse what the fixer handed back. A round that did not hand back a usable file escalates, so
// this never throws — it reports.
export function parseOutcome(text) {
  let data;
  try { data = JSON.parse(String(text ?? "")); }
  catch (e) {
    return { ok: false, reason: `the round's hand-back is not valid JSON (${e.message}).`, outcome: null, data: null };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "the round's hand-back is not a JSON object.", outcome: null, data: null };
  }
  const outcome = String(data.outcome ?? "").trim();
  if (!OUTCOMES.includes(outcome)) {
    return {
      ok: false,
      reason: `the round's hand-back names no known outcome (expected ${OUTCOMES.join(" or ")}).`,
      outcome: null,
      data,
    };
  }
  return { ok: true, reason: "", outcome, data };
}

// Card input built from the round's own hand-back, amended with whatever stopped the round. The
// worker's four fields are reused verbatim where they exist — it is the only thing that knows
// what it tried — and `amend` is prefixed to `tried` so the guard's verdict is never buried.
export function cardFromOutcome(data, { amend = "", check = "review", link = "", rounds = 0, cap = 0 } = {}) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const tried = [amend, typeof d.tried === "string" ? d.tried.trim() : ""].filter(Boolean).join(" ");
  return {
    check,
    link,
    rounds,
    cap,
    finding: typeof d.finding === "string" ? d.finding : "",
    tried,
    recommendation: d.recommendation,
    alternative: typeof d.alternative === "string" ? d.alternative : "",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
//
// Thin by design: every command below is a two-line shell over an exported pure function, so
// what the workflow runs is what the tests run. `_flow-kickback.yml` calls:
//
//   decide    reads the gathered facts from the environment, writes the verdict to GITHUB_OUTPUT
//   rounds    counts round trailers in a NUL-delimited commit-message file
//   weakens   runs the test-weakening guard over a diff file; exit 1 when it trips
//   card      renders the decision card from a hand-back file (or from nothing) to stdout

export function runKickbackCli(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const read = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  const append = opts.appendFile ?? ((p, s) => appendFileSync(p, s));
  const emit = (kv) => {
    if (!env.GITHUB_OUTPUT) return;
    append(env.GITHUB_OUTPUT,
      Object.entries(kv).map(([k, v]) => `${k}<<FLOW_EOF\n${v}\nFLOW_EOF\n`).join(""));
  };
  const [cmd, ...rest] = argv;

  if (cmd === "decide") {
    const verdict = decide({
      failedChecks: env.KICKBACK_FAILED_CHECKS,
      draft: env.KICKBACK_DRAFT,
      fork: env.KICKBACK_FORK,
      labels: env.KICKBACK_LABELS,
      taskId: env.KICKBACK_TASK_ID,
      taskStatus: env.KICKBACK_TASK_STATUS,
      rounds: countRounds(env.KICKBACK_COMMITS_FILE
        ? read(env.KICKBACK_COMMITS_FILE).split(MESSAGE_SEPARATOR) : []),
      configuredCap: parseAutoFixRounds(env.FLOW_CONFIG ? read(env.FLOW_CONFIG) : ""),
      flowAi: env.FLOW_AI,
      flowPat: env.KICKBACK_HAS_PAT,
    });
    emit({
      action: verdict.action,
      reason: verdict.reason,
      round: String(verdict.round),
      rounds_used: String(verdict.rounds),
      cap: String(verdict.cap),
      warning: verdict.warning,
      trailer: roundTrailer(verdict.round, verdict.cap),
    });
    out(`${verdict.action}: ${verdict.reason}\n`);
    if (verdict.warning) err(`::warning::${verdict.warning}\n`);
    return 0;
  }

  if (cmd === "rounds") {
    out(`${countRounds(read(rest[0]).split(MESSAGE_SEPARATOR))}\n`);
    return 0;
  }

  if (cmd === "weakens") {
    const offenders = weakensTests(read(rest[0]));
    if (offenders.length === 0) { out("clean — no test weakening detected\n"); return 0; }
    out(`${weakensReport(offenders)}\n`);
    return 1;
  }

  if (cmd === "card") {
    let data = null;
    try { data = rest[0] ? parseOutcome(read(rest[0])).data : null; } catch { data = null; }
    out(decisionCard(cardFromOutcome(data, {
      amend: env.KICKBACK_AMEND ?? "",
      check: env.KICKBACK_CHECK ?? "review",
      link: env.KICKBACK_LINK ?? "",
      rounds: Number(env.KICKBACK_ROUNDS_USED ?? 0),
      cap: Number(env.KICKBACK_CAP ?? 0),
    })));
    return 0;
  }

  err("usage: flow-kickback.mjs <decide|rounds|weakens|card> [file]\n");
  return 2;
}

if (__isMain) process.exit(runKickbackCli(process.argv.slice(2)));
