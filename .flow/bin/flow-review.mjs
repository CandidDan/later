#!/usr/bin/env node
// flow-review.mjs — the deterministic half of the review gate (flow-0007).
//
// The three Definition-of-Done reviewers — qa, code-review, security — used to run as subagents
// INSIDE the worker's own session, which made the worker the certifier of its own work. Every
// other guard in Flow refuses to do that: touches-guard enforces scope in CI, the store-guard
// fails a PR that edits task state, flow-doctor validates the store. The reviewers now run the
// same way, as jobs on the PR (`_flow-review.yml`).
//
// A model call cannot be the whole gate, though, because a model call always exits 0. Two pieces
// have to be real code, and they live here:
//
//   plan     — reads `review:` out of the caller repo's .flow/config.yml, decides whether the
//              conditional security review applies to THIS diff, and materialises the bounded
//              context (changed files + a size-capped diff) the reviewers are allowed to read.
//              That bound is what keeps per-PR cost flat as the codebase grows; left to a prompt
//              it erodes silently, because a reviewer that read the whole repo still looks fine.
//   verdict  — turns a reviewer's written verdict into an exit code. FAIL-CLOSED: a missing,
//              empty or unparseable verdict is a failure, never a pass. A reviewer that died
//              mid-run must not read as approval — that is the one bug that would make this
//              whole gate theatre.
//
// Zero dependencies, Node >= 18. `_flow-gates.yml`'s `flow-tooling` job runs
// `node --test .flow/bin/*.test.mjs` with NO install step in front of it, so an import of
// `yaml` here would die before a single test ran. The `review:` scan below is deliberately a
// narrow, tolerant reader of the two shapes config.yml actually uses, not a YAML parser.
//
//   node .flow/bin/flow-review.mjs plan
//   node .flow/bin/flow-review.mjs verdict .flow-review/qa.json --check qa

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { globToRegExp } from "./touches-guard.mjs";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reached
// through a symlink they differ, the CLI block never runs, and the review gate exits 0 having
// checked nothing — a guard that fails open. Compare realpaths on both sides.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

// The model used when `review.model` is absent. It is a DEFAULT, not a hardcode: nothing in
// `_flow-review.yml` names a model, so a repo changes every reviewer by editing config.yml.
// `plan` reports loudly when it falls back, so an unconfigured repo is visible rather than
// quietly running on whatever this line happens to say.
export const DEFAULT_MODEL = "sonnet";

// Cap on the diff handed to a reviewer. The bound is the cost control: reviewers read the diff
// and its blast radius, never the whole repo. A truncated diff is reported, not hidden — a
// reviewer that silently saw half a change would approve on half the evidence.
export const DEFAULT_MAX_DIFF_BYTES = 300_000;

export const CHECKS = ["qa", "code-review", "security"];

export class ReviewError extends Error {}

// A model name reaches the reviewer as command-line text (`--model <x>`). config.yml is
// repo-owned, so this is not a privilege boundary — but a value carrying a space or a quote
// would splice extra flags into the invocation and the run would fail somewhere far from the
// typo. Reject it here, where the message can name the file and the key.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function checkModel(value, key) {
  if (!MODEL_RE.test(value)) {
    throw new ReviewError(
      `review.${key} = ${JSON.stringify(value)} is not a usable model name. It is passed to the ` +
      `reviewer as \`--model <value>\`, so it must be a bare identifier (letters, digits, ` +
      `\`.\`, \`_\`, \`-\`) — e.g. "sonnet" or "claude-opus-5".`);
  }
  return value;
}

// ── config ────────────────────────────────────────────────────────────────────────────────
// Pull the `review:` block out of config.yml without a YAML dependency. Handles the two shapes
// the file actually uses — inline arrays and `-` lists — and treats anything it does not
// recognise as absent, which lands on the documented default rather than on a crash.
export function reviewBlock(src) {
  const lines = String(src ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^review:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { out.push(line); continue; }
    if (/^\S/.test(line)) break;                      // back at column 0 — the next top-level key
    out.push(line);
  }
  return out.join("\n");
}

// Strip a trailing `# comment` from an unquoted scalar, and the quotes from a quoted one.
function scalar(raw) {
  const s = String(raw).trim();
  const quoted = s.match(/^"([^"]*)"|^'([^']*)'/);
  return (quoted ? (quoted[1] ?? quoted[2]) : s.replace(/\s+#.*$/, "")).trim();
}

// A string list under `key:`, in either shape. Returns [] when the key is absent or empty.
function listAt(block, key) {
  const inline = block.match(new RegExp(`^\\s*${key}:\\s*\\[(.*?)\\]`, "ms"));
  if (inline) {
    const items = [...inline[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    // Tolerate an unquoted inline list too (`[a/**, b]`) — config.yml is hand-edited.
    if (items.length) return items.filter(Boolean);
    return inline[1].split(",").map(scalar).filter(Boolean);
  }
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*(#.*)?$`).test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*\S)\s*$/);
    if (!item) break;
    const value = scalar(item[1]);
    if (value) out.push(value);
  }
  return out;
}

function stringAt(block, key) {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*(\\S.*)$`, "m"));
  const v = m ? scalar(m[1]) : "";
  return v || "";
}

// `review:` as the workflow needs it, with every fallback made explicit rather than implied.
export function parseReviewConfig(src) {
  const block = reviewBlock(src);
  const warnings = [];
  if (block === null) {
    warnings.push(
      "no `review:` block in .flow/config.yml — using defaults. Add one to choose the reviewer " +
      "model and to scope the security review to the paths that warrant it.",
    );
  }
  const b = block ?? "";
  const model = stringAt(b, "model");
  if (!model) warnings.push(`review.model is not set — falling back to "${DEFAULT_MODEL}".`);
  const securityModel = stringAt(b, "security_model");
  const securityPaths = listAt(b, "security_paths");
  return {
    model: checkModel(model || DEFAULT_MODEL, "model"),
    // A repo that wants a deeper model on security diffs says so; otherwise one model, one knob.
    securityModel: checkModel(securityModel || model || DEFAULT_MODEL, "security_model"),
    securityPaths,
    configured: block !== null,
    warnings,
  };
}

// ── the conditional security review ───────────────────────────────────────────────────────
// Runs on diffs that touch a configured trigger path, and is SKIPPED — visibly, with the reason
// carried out to the job summary — on diffs that do not. An unconfigured repo runs it every
// time: the fail-closed direction, because "nobody scoped it yet" must not read as "nothing to
// review here".
export function securityDecision({ changedFiles = [], securityPaths = [] } = {}) {
  const files = changedFiles.filter(Boolean);
  if (!securityPaths.length) {
    return {
      run: true,
      matched: [],
      reason:
        "no `review.security_paths` configured — running the security review on every PR. " +
        "Scope it by listing the paths that warrant one (auth, external input, data access, " +
        "dependencies) under `review.security_paths` in .flow/config.yml.",
    };
  }
  const res = securityPaths.map(globToRegExp);
  const matched = files.filter((f) => res.some((r) => r.test(f)));
  if (matched.length) {
    return {
      run: true,
      matched,
      reason: `diff touches ${matched.length} configured security path(s): ${matched.slice(0, 10).join(", ")}` +
        (matched.length > 10 ? ` (+${matched.length - 10} more)` : ""),
    };
  }
  return {
    run: false,
    matched: [],
    reason:
      `SKIPPED — none of the ${files.length} changed file(s) match the ${securityPaths.length} ` +
      `configured security trigger path(s): ${securityPaths.join(", ")}. This skip is a decision, ` +
      `not an omission; widen \`review.security_paths\` in .flow/config.yml if it is wrong.`,
  };
}

// ── the bounded context ───────────────────────────────────────────────────────────────────
// Truncation is reported in the returned object AND written into the text, so a reviewer reading
// a clipped diff is told it is clipped instead of reasoning confidently about half a change.
export function boundDiff(text, { maxBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  const src = String(text ?? "");
  const full = Buffer.byteLength(src, "utf8");
  if (full <= maxBytes) return { text: src, truncated: false, bytes: full, fullBytes: full };
  const kept = Buffer.from(src, "utf8").subarray(0, maxBytes).toString("utf8");
  const marker =
    `\n\n*** DIFF TRUNCATED at ${maxBytes} bytes (full diff is ${full} bytes). ***\n` +
    `*** You are seeing part of this change. Say so in your verdict rather than approving ` +
    `what you could not read. ***\n`;
  return { text: kept + marker, truncated: true, bytes: Buffer.byteLength(kept + marker, "utf8"), fullBytes: full };
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────
// A reviewer's judgement arrives as JSON it wrote to a file. Models fence their JSON by habit,
// so a fence is tolerated; nothing else is. Anything unreadable throws, and the CLI turns that
// into a non-zero exit — see FAIL-CLOSED at the top of this file.
export function parseVerdict(src) {
  const raw = String(src ?? "").trim();
  if (!raw) throw new ReviewError("verdict is empty — a reviewer that wrote nothing has not passed");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new ReviewError(`verdict is not valid JSON (${e.message}) — refusing to read it as a pass`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewError("verdict must be a JSON object");
  }
  const verdict = String(parsed.verdict ?? "").trim().toUpperCase();
  if (verdict !== "PASS" && verdict !== "FAIL") {
    throw new ReviewError(`verdict must be "PASS" or "FAIL", got ${JSON.stringify(parsed.verdict ?? null)}`);
  }
  const asList = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  return {
    verdict,
    unproven: asList(parsed.unproven).map(String),
    blocking: asList(parsed.blocking),
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    notes: asList(parsed.notes).map(String),
  };
}

const findingLine = (f) =>
  typeof f === "string" ? f
    : [f?.file && `${f.file}${f.line ? `:${f.line}` : ""}`, f?.issue, f?.fix && `fix: ${f.fix}`]
      .filter(Boolean).join(" · ") || JSON.stringify(f);

// Decide the check's outcome from a parsed verdict. A self-contradicting verdict — PASS while
// naming an unproven criterion or a blocking finding — resolves to FAIL. The reviewer's stated
// letter grade is not allowed to overrule its own evidence.
export function verdictOutcome(parsed, { check = "review" } = {}) {
  const lines = [];
  let failed = parsed.verdict === "FAIL";
  if (parsed.unproven.length) {
    failed = true;
    lines.push(`${check}: ${parsed.unproven.length} acceptance criterion/criteria with no proving test:`);
    for (const c of parsed.unproven) lines.push(`  unproven criterion: ${c}`);
  }
  if (parsed.blocking.length) {
    failed = true;
    lines.push(`${check}: ${parsed.blocking.length} blocking finding(s):`);
    for (const f of parsed.blocking) lines.push(`  blocking: ${findingLine(f)}`);
  }
  if (failed && !lines.length) {
    lines.push(`${check}: verdict FAIL${parsed.summary ? ` — ${parsed.summary}` : ""}`);
  }
  return { ok: !failed, code: failed ? 1 : 0, lines, summary: parsed.summary };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
const emit = (file, text) => { if (file) appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`); };

// The whole CLI, exported as a function that RETURNS the exit code instead of calling
// process.exit. Canonical's `.flow/bin/flow-review.mjs` adapter invokes this same shell against
// its own store rather than carrying a copy of it — two copies of one shell is the flow-0008
// hazard in miniature: the same fix needed twice, and the gate green when only one lands
// (see touches-guard.mjs for the incident).
//
// `opts` supplies the defaults an adapter pins (its config path, its out dir, a `git` bound to
// its repo root); the environment overrides (FLOW_CONFIG, REVIEW_OUT_DIR, BASE_REF,
// REVIEW_DIFF_MAX_BYTES) still win over those defaults, because that is the contract
// `_flow-review.yml` and the tests already rely on.
export function runReviewCli(argv, {
  env = process.env,
  configPath = ".flow/config.yml",
  outDir = ".flow-review",
  git,
} = {}) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "plan") {
      const plan = runPlan({
        configPath: env.FLOW_CONFIG || configPath,
        outDir: env.REVIEW_OUT_DIR || outDir,
        baseRef: env.BASE_REF || "origin/main",
        maxBytes: Number(env.REVIEW_DIFF_MAX_BYTES || DEFAULT_MAX_DIFF_BYTES),
        ...(git ? { git } : {}),
      });
      const { cfg, changedFiles, security, diff } = plan;
      emit(env.GITHUB_OUTPUT, [
        `model=${cfg.model}`,
        `security_model=${cfg.securityModel}`,
        `security_run=${security.run}`,
        `security_reason=${security.reason.replace(/\r?\n/g, " ")}`,
        `changed_count=${changedFiles.length}`,
        `diff_truncated=${diff.truncated}`,
      ].join("\n"));
      const summary = planSummary(plan);
      emit(env.GITHUB_STEP_SUMMARY, summary);
      console.log(summary);
      return 0;
    }

    if (cmd === "verdict") {
      const file = rest.find((a) => !a.startsWith("--"));
      const ci = rest.indexOf("--check");
      const check = ci !== -1 ? rest[ci + 1] : "review";
      if (!file) throw new ReviewError("usage: flow-review.mjs verdict <file> [--check <name>]");
      if (!existsSync(file)) {
        throw new ReviewError(`no verdict at ${file} — the ${check} reviewer produced none. ` +
          `A missing verdict fails the check: a reviewer that did not report has not approved.`);
      }
      const parsed = parseVerdict(readFileSync(file, "utf8"));
      const outcome = verdictOutcome(parsed, { check });
      const md = [`### ${check} review — ${outcome.ok ? "PASS" : "FAIL"}`, ""]
        .concat(parsed.summary ? [parsed.summary, ""] : [])
        .concat(outcome.lines.map((l) => `- ${l}`))
        .join("\n");
      emit(env.GITHUB_STEP_SUMMARY, md);
      for (const l of outcome.lines) console.error(`::error::${l}`);
      console.log(`${check}: ${outcome.ok ? "PASS" : "FAIL"}${parsed.summary ? ` — ${parsed.summary}` : ""}`);
      return outcome.code;
    }

    throw new ReviewError(`unknown command ${JSON.stringify(cmd ?? "")} — expected "plan" or "verdict"`);
  } catch (e) {
    console.error(`::error::flow-review: ${e.message}`);
    return 1;
  }
}

export function runPlan({
  configPath = ".flow/config.yml",
  outDir = ".flow-review",
  baseRef = process.env.BASE_REF || "origin/main",
  maxBytes = Number(process.env.REVIEW_DIFF_MAX_BYTES || DEFAULT_MAX_DIFF_BYTES),
  git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }),
  read = (p) => readFileSync(p, "utf8"),
} = {}) {
  if (!existsSync(configPath)) {
    throw new ReviewError(`${configPath} not found — the review gate reads its model and its ` +
      `security triggers from the repo's own config, and will not invent them`);
  }
  const cfg = parseReviewConfig(read(configPath));
  const changedFiles = git(["diff", "--name-only", `${baseRef}...HEAD`])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const security = securityDecision({ changedFiles, securityPaths: cfg.securityPaths });
  const diff = boundDiff(git(["diff", `${baseRef}...HEAD`]), { maxBytes });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "files.txt"), changedFiles.join("\n") + (changedFiles.length ? "\n" : ""));
  writeFileSync(join(outDir, "diff.patch"), diff.text);

  return { cfg, changedFiles, security, diff, outDir };
}

function planSummary({ cfg, changedFiles, security, diff }) {
  const out = [
    "### Flow review gate — plan",
    "",
    `- reviewer model: \`${cfg.model}\`${cfg.configured ? "" : " *(default — no `review:` block in .flow/config.yml)*"}`,
    `- security reviewer model: \`${cfg.securityModel}\``,
    `- changed files: ${changedFiles.length}`,
    `- diff handed to the reviewers: ${diff.bytes} bytes${diff.truncated ? ` **(truncated from ${diff.fullBytes})**` : ""}`,
    `- security review: **${security.run ? "RUNNING" : "SKIPPED"}** — ${security.reason}`,
  ];
  for (const w of cfg.warnings) out.push(`- :warning: ${w}`);
  return out.join("\n");
}

if (__isMain) process.exit(runReviewCli(process.argv.slice(2)));
