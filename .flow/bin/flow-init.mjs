#!/usr/bin/env node
// flow-init.mjs — the mechanical half of adoption (INIT.md steps 1–4), as tested code.
//
//   node flow-init.mjs --config init.json            # from a JSON input file
//   node flow-init.mjs --name acme --install "npm ci" … --dry-run
//
// WHY THIS EXISTS. Adoption used to be a ten-step prose runbook, and prose has one structural
// weakness: nothing fails when a step is skipped. A missed `uses:` re-pin, a short copy of the
// callers, a `test` command someone guessed rather than measured — each produces a repo that
// looks adopted and gates nothing. The guessed command is the worst of them, because a green
// gate that proves nothing is more dangerous than a red one: the ceremony is there, the
// enforcement is not, and nobody finds out until something ships broken.
//
// So the deterministic steps move here (copy the tree, re-pin the callers, stamp the version,
// write the config, set the board's repo) and the judgement stays with the caller: this tool
// NEVER invents a config value. Every input it needs and cannot derive is REQUIRED, and a
// missing one is a non-zero exit naming the field — not a default.
//
// EXIT CODES (a caller can branch on these):
//   0  wrote the plan, or --dry-run, or already initialised and byte-identical (a no-op)
//   1  bad input, bad environment, or a canonical checkout that isn't one
//   3  the target already holds files that DIFFER from the plan, and --force was not given
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not run the gate, seed tasks, register with the
// flightdeck, or touch repo settings — those are judgement, human-only, or both (INIT.md
// steps 5–9). Two smaller omissions are deliberate too, and both are the same principle:
//
//   · The template's sample task (`.flow/tasks/0001-*.md`) is NOT copied. It is a reference for
//     reading canonical's template, not content for a new repo — copied in, it becomes a `ready`
//     task a queue-runner can genuinely dispatch, against files that do not exist. Only
//     `_TEMPLATE.md` travels. The board's snapshot is emptied to match, so the store and the
//     board agree from the first commit.
//   · `VISION.md` is NOT copied. It ships as a shape with placeholder goals, and a placeholder
//     vision is worse than none: `serves:` would resolve against slots nobody wrote. The
//     `vision-writer` skill interviews a human for it — judgement, not a copy.
//
// NETWORK. Exactly one function reaches the network: `resolveCanonical`, and only when `--from`
// is absent. `--from <dir>` points at a canonical checkout already on disk, which is how the
// tests run (they must never hit the network) and how CI can run this against its own checkout.
//
// NO INTERACTIVE MODE, EVER. The caller is an agent, a human, or CI. A tool that can block on
// stdin is a tool that hangs a CI job until it times out.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { realpathSync as __realpathSync } from "node:fs";
import { fileURLToPath as __fileURLToPath } from "node:url";

// --- main-module detection (do not simplify back to a string compare) -------------------
// `import.meta.url` is the RESOLVED realpath; `process.argv[1]` is the path AS INVOKED. Reached
// through a symlink they differ, the comparison is false, and the CLI block below silently never
// runs — no output, exit 0, nothing to debug. macOS hits this routinely because os.tmpdir()
// (/var/folders/…) is a symlink to /private/var/folders/…. See main-module.test.mjs.
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      __realpathSync(process.argv[1]) === __realpathSync(__fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

export const DEFAULT_CANONICAL_REPO = "CandidDan/flow";
export const DEFAULT_CANONICAL_REF = "v1";

// The five commands, in the order they run. Named here so a missing one is reported by name.
export const COMMAND_KEYS = ["install", "build", "lint", "test", "coverage"];

// Which repo-root files travel is decided by SUBTRACTION, not by a list of names: everything at
// the top of the template ships except the exclusions below. A list of includes rots the moment
// canonical adds a file — the same failure as writing the caller count in a document — and it
// would have to name the host files one by one, which is precisely the vendor binding flow-0006
// took out of the tooling.
//
// Excluded: canonical's own adoption documentation (it is read IN canonical, never copied into a
// repo that has already adopted), the shape-only VISION.md, and .gitignore (merged, not copied).
const ROOT_EXCLUDE = new Set([
  "README.md", "INIT.md", "RETROFIT.md", "FLOW-handoff.html", "VISION.md", ".gitignore",
]);

// The generic focus areas the template ships. Used only when the caller supplies none — they are
// the shipped defaults, not a guess about this project, and the run says so out loud.
const GENERIC_SECURITY_FOCUS = [
  "authn/authz boundaries",
  "input validation on all external entry points",
  "secret storage (vaults/env, never source)",
];

const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A ref is interpolated into the callers' YAML inside single quotes and passed to `git clone
// --branch`. Anything outside this alphabet — a quote, a space, a shell metacharacter — is
// rejected before it reaches either, so neither the YAML nor the argv can be broken out of.
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class InitError extends Error {}

// ── inputs ─────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Map(Object.entries({
  "--config": "config", "--target": "target", "--from": "from",
  "--name": "name", "--language": "language", "--description": "description",
  "--repo": "repo", "--coverage-min": "coverageMin",
  "--canonical-repo": "canonicalRepo", "--canonical-ref": "canonicalRef",
  ...Object.fromEntries(COMMAND_KEYS.map((k) => [`--${k}`, `cmd.${k}`])),
}));
const LIST_FLAGS = new Map(Object.entries({
  "--source-root": "sourceRoots", "--security-focus": "securityFocus",
}));
const BOOL_FLAGS = new Map(Object.entries({
  "--dry-run": "dryRun", "--force": "force", "--help": "help", "-h": "help",
}));

// Parse argv into a flat bag. Unknown flags and bare positionals are ERRORS, not ignored: a
// typo'd `--coverage-min` that is silently dropped would fall through to "missing required
// field", which reports the wrong problem, or worse, be silently absent from a JSON-driven run.
export function parseArgs(argv) {
  const flags = { sourceRoots: [], securityFocus: [] };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) { flags[BOOL_FLAGS.get(a)] = true; continue; }
    const key = VALUE_FLAGS.get(a) ?? LIST_FLAGS.get(a);
    if (!key) {
      errors.push(`unknown argument "${a}"`);
      // Swallow its value too, so one typo reports one problem instead of two.
      if (a.startsWith("-") && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i++;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) { errors.push(`${a} needs a value`); continue; }
    if (LIST_FLAGS.has(a)) flags[key].push(value);
    else if (key.startsWith("cmd.")) (flags.commands ??= {})[key.slice(4)] = value;
    else flags[key] = value;
  }
  return { flags, errors };
}

// "src/=npm run lint" → { path: "src/", check: "npm run lint" }. Split on the FIRST `=` so a
// check containing `=` (a flag with a value, say) survives intact.
export function parseSourceRootFlag(raw) {
  const at = raw.indexOf("=");
  if (at === -1) return { path: raw, check: "" };
  return { path: raw.slice(0, at).trim(), check: raw.slice(at + 1).trim() };
}

// Merge a JSON config file (shaped like .flow/config.yml) with flags; flags win. Returns the
// input record plus any read/parse errors — never throws, so every problem is reported in one
// pass rather than one exit per run.
export function loadInputs(argv, readFile = (p) => readFileSync(p, "utf8")) {
  const { flags, errors } = parseArgs(argv);
  let file = {};
  if (flags.config) {
    try { file = JSON.parse(readFile(flags.config)); }
    catch (e) { errors.push(`--config ${flags.config}: ${e.message}`); }
  }
  const pick = (a, b) => (a !== undefined && a !== "" ? a : b);
  const fileCommands = file.commands ?? {};
  const commands = {};
  for (const k of COMMAND_KEYS) commands[k] = pick(flags.commands?.[k], fileCommands[k]) ?? "";

  const sourceRoots = flags.sourceRoots.length
    ? flags.sourceRoots.map(parseSourceRootFlag)
    : (Array.isArray(file.source_roots) ? file.source_roots.map((r) => ({ path: r?.path ?? "", check: r?.check ?? "" })) : []);

  const focus = flags.securityFocus.length
    ? flags.securityFocus
    : (Array.isArray(file.security?.focus) ? file.security.focus : []);

  const rawCoverage = pick(flags.coverageMin, file.coverage_min);

  return {
    inputs: {
      project: {
        name: pick(flags.name, file.project?.name) ?? "",
        language: pick(flags.language, file.project?.language) ?? "",
        description: pick(flags.description, file.project?.description) ?? "",
      },
      repo: pick(flags.repo, file.repo) ?? "",
      commands,
      coverage_min: rawCoverage === undefined ? "" : rawCoverage,
      source_roots: sourceRoots,
      security: { focus, defaulted: focus.length === 0 },
      canonical: {
        repo: pick(flags.canonicalRepo, file.canonical?.repo) ?? DEFAULT_CANONICAL_REPO,
        ref: pick(flags.canonicalRef, file.canonical?.ref) ?? DEFAULT_CANONICAL_REF,
      },
      from: flags.from ?? "",
      target: flags.target ?? ".",
      dryRun: !!flags.dryRun,
      force: !!flags.force,
      help: !!flags.help,
    },
    errors,
  };
}

// A source root must be a path INSIDE the repo, expressed relative to its root. Two reasons, and
// the second is the load-bearing one: `join(target, "../src")` normalises to a directory OUTSIDE
// the target, so the existence check would happily confirm a tree this repo does not contain; and
// the same string is written into `.flow/config.yml`, where flow-doctor resolves it against the
// repo root on every later run. A root that climbs out is a gate aimed at another repo's files.
//
// An absolute path does NOT escape `join` — it nests under the target — but it is meaningless in a
// config file that travels to other checkouts, so it is refused here by name rather than left to
// resurface later as a puzzling missing directory.
const escapesRepo = (p) => isAbsolute(p) || p.split(/[\\/]/).includes("..");

// A usable single-line value. Control characters are rejected rather than escaped: they would
// travel into config.yml (which flow-doctor parses by line scan), and a newline inside a
// "command" is not a command, it is two.
const isScalar = (v) =>
  typeof v === "string" && v.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(v);

// Everything that must be true before a single byte is written. Returns a list of human-readable
// problems, each naming the field, so one run reports every missing input instead of drip-feeding
// them. `exists` is injectable purely so the source_root check can be exercised without a fixture.
export function validateInputs(inputs, { targetDir, exists = existsSync } = {}) {
  const errors = [];
  const need = (v, name, hint) => { if (!isScalar(v)) errors.push(`${name} is required${hint ? ` — ${hint}` : ""}`); };

  need(inputs.project.name, "project.name", "the short slug, also the task-id prefix");
  need(inputs.project.language, "project.language");
  need(inputs.project.description, "project.description", "one line");
  if (!OWNER_REPO.test(String(inputs.repo || "")))
    errors.push(`repo must be "owner/repo" (got ${JSON.stringify(inputs.repo)}) — it targets the board's "Work this" link`);

  for (const k of COMMAND_KEYS) {
    need(inputs.commands[k], `commands.${k}`,
      "no default exists: a guessed command produces a green gate that proves nothing");
  }

  const cov = Number(inputs.coverage_min);
  if (inputs.coverage_min === "" || inputs.coverage_min === null || Number.isNaN(cov))
    errors.push("coverage_min is required — MEASURE it by running the coverage command once, then set the floor just under what it reported");
  else if (cov < 0 || cov > 100) errors.push(`coverage_min must be between 0 and 100 (got ${cov})`);

  if (!inputs.source_roots.length) {
    errors.push("source_roots is required — declare every tree that holds source and the command that parses it");
  } else {
    for (const [i, r] of inputs.source_roots.entries()) {
      if (!isScalar(r.path)) { errors.push(`source_roots[${i}].path is required`); continue; }
      if (!isScalar(r.check)) errors.push(`source_roots[${i}] ("${r.path}") has no check — name the command that parses this tree`);
      if (escapesRepo(r.path)) {
        errors.push(`source_root "${r.path}" must be a repo-relative path inside the target — an absolute ` +
          `path, or one climbing out with "..", declares a tree this repo does not contain, and config.yml ` +
          `carries it to every later flow-doctor run`);
        continue;
      }
      if (targetDir && !exists(join(targetDir, r.path)))
        errors.push(`source_root "${r.path}" does not exist in the target repo — a root that isn't there cannot be gated`);
    }
  }

  for (const [i, f] of inputs.security.focus.entries())
    if (!isScalar(f)) errors.push(`security.focus[${i}] must be a single-line string`);

  if (!OWNER_REPO.test(String(inputs.canonical.repo || "")))
    errors.push(`canonical.repo must be "owner/repo" (got ${JSON.stringify(inputs.canonical.repo)})`);
  if (!REF.test(String(inputs.canonical.ref || "")))
    errors.push(`canonical.ref ${JSON.stringify(inputs.canonical.ref)} is not a plain git ref — refs are interpolated into workflow YAML and a git command line, so only [A-Za-z0-9._/-] is accepted`);

  return errors;
}

// ── rendering ──────────────────────────────────────────────────────────────────────────

const yamlStr = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// `.flow/config.yml`, the one genuinely per-project file. Written from the supplied values with
// the template's load-bearing warnings kept — a consuming repo's config is a document humans
// read and edit, and stripping the reasons is how the reasons get lost.
export function renderConfig(inputs) {
  const focus = inputs.security.focus.length ? inputs.security.focus : GENERIC_SECURITY_FOCUS;
  const lines = [
    "# .flow/config.yml — the ONLY file that changes per stack.",
    "#",
    `# Written by flow-init from ${inputs.canonical.repo}@${inputs.canonical.ref}. Every value below was`,
    "# SUPPLIED, not guessed — flow-init has no defaults for the commands, the source roots or the",
    "# coverage floor. Recalibrate by hand (it is a normal file) or re-run flow-init --force.",
    "",
    "project:",
    `  name: ${yamlStr(inputs.project.name)}            # short slug, also the task-id prefix`,
    `  language: ${yamlStr(inputs.project.language)}`,
    `  description: ${yamlStr(inputs.project.description)}`,
    "",
    "# Commands. Each must exit non-zero on failure so CI and the qa-verifier can trust them.",
    "#",
    "# COVER EVERY SOURCE TREE. The gate only validates what these commands actually reach. A tree",
    "# no command parses is never checked until production. (Real incident: edge functions were",
    "# Deno-only, the gate ran only in app/, and a parse error took down inbound for ~7 days.)",
    "#",
    "# NOTE for lockfile stacks: if `install` is strict (`npm ci`, `pnpm i --frozen-lockfile`,",
    "# `poetry install --sync`), re-run it locally after adding any dependency and commit the",
    "# resynced lockfile. A half-updated lock passes a lenient local install and fails the gate.",
    "commands:",
    ...COMMAND_KEYS.map((k) => `  ${(k + ":").padEnd(9)} ${yamlStr(inputs.commands[k])}`),
    "",
    "# The coverage FLOOR — a backstop, not the real gate. It's a blunt, game-able signal (lines",
    "# executed, not behaviour proven), so the actual correctness check is the qa-verifier's",
    "# criterion->test mapping; this just stops coverage quietly collapsing. Raise it over time,",
    "# never lower it silently. Sitting exactly at the floor proves nothing.",
    `coverage_min: ${Number(inputs.coverage_min)}`,
    "",
    "# Source roots — the gate-coverage floor. flow-doctor FAILS on a declared root that is missing",
    "# or has no check, and on any top-level source tree not covered here, so a runtime added six",
    "# months from now can't slip in ungated. If a tree genuinely shouldn't be gated, add it to",
    "# flow-doctor's ROOT_IGNORE rather than leaving it silently uncovered.",
    "source_roots:",
    ...inputs.source_roots.flatMap((r) => [
      `  - path: ${yamlStr(r.path)}`,
      `    check: ${yamlStr(r.check)}`,
    ]),
    "",
    "# Security expectations the security-reviewer enforces on top of its general review.",
    "security:",
    "  secrets_scan: true            # no credentials, tokens, keys committed",
    "  dependency_audit: true        # e.g. \"npm audit\" / \"pip-audit\" — wire into CI",
    `  focus:${inputs.security.focus.length ? "" : "                        # generic defaults — tailor them to this project"}`,
    ...focus.map((f) => `    - ${yamlStr(f)}`),
    "",
    "# Branch + PR conventions (kept here so agents and CI agree).",
    "git:",
    "  base_branch: \"main\"",
    "  branch_prefix: \"flow/\"        # branches are flow/<task-id>-<slug>",
    "  protect_main: true            # never commit to base directly",
    "",
  ];
  return lines.join("\n");
}

// Re-point a thin caller at the canonical repo/ref this repo is adopting.
//
// Two rewrites, not one, and the second is the one everybody forgets: `_flow-sync.yml` defaults
// its own `canonical_ref` input to 'v1' INDEPENDENTLY of what the callers pin. A repo pinned to
// v1-edge whose flow-sync caller passes an empty ref runs EDGE workflows while syncing STABLE
// tooling — a split brain that fails quietly, because both halves work and only disagree about
// which release this repo is on. See docs/repinning-a-consuming-repo.md.
//
// Third-party `uses:` lines (actions/checkout and friends) are deliberately untouched — only the
// `_flow-*.yml` reusables belong to canonical.
export function repin(text, { repo, ref }) {
  return text
    .replace(/^(\s*uses:\s*)\S+\/\.github\/workflows\/(_flow-[a-z-]+\.yml)@\S+[ \t]*$/gm,
      (_m, head, wf) => `${head}${repo}/.github/workflows/${wf}@${ref}`)
    .replace(/^(\s*canonical_ref:\s*)\$\{\{\s*inputs\.canonical_ref(?:\s*\|\|\s*'[^']*')?\s*\}\}[ \t]*$/gm,
      (_m, head) => `${head}\${{ inputs.canonical_ref || '${ref}' }}`)
    // Keep the dispatch input's advertised default honest — a description that still says
    // "Default v1." on a v1-edge repo is how the trap above gets re-introduced by hand.
    .replace(/^(\s*description:\s*"Canonical ref[^"\n]*Default )[^"\n.]+(\."[ \t]*)$/gm,
      (_m, head, tail) => `${head}${ref}${tail}`);
}

// Point the board at this repo, and empty its task snapshot. The snapshot ships holding the
// template's sample task, which flow-init does not copy — leaving it would make the board
// disagree with the store on the repo's very first commit, and flow-doctor say so.
export function prepareBoard(text, repo) {
  return text
    .replace(/^const REPO = "[^"]*";/m, `const REPO = ${yamlStr(repo)};`)
    .replace(/^const TASKS = \[[\s\S]*?\n\];/m, "const TASKS = [\n];");
}

// `.gitignore` is MERGED, never clobbered — a new repo may already have one, and replacing it
// would silently un-ignore whatever it protected. Appends only the lines the target lacks, so a
// second run finds nothing missing and returns the file byte-identical (that is what makes the
// whole run idempotent, not just this file).
export function mergeGitignore(existing, canonical) {
  if (existing === null || existing === undefined) return canonical;
  const present = new Set(existing.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  const missing = canonical.split("\n").filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("#") && !present.has(t);
  });
  if (!missing.length) return existing;
  const head = existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
  return `${head}\n# --- Flow ---\n${missing.join("\n")}\n`;
}

// ── the plan ───────────────────────────────────────────────────────────────────────────

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

// Everything the run would write, as (path, bytes) pairs. Pure with respect to the two trees it
// reads: same canonical checkout + same inputs → identical bytes, which is what makes "re-run and
// compare" a meaningful idempotency check rather than a timestamp diff.
export function buildPlan({ canonicalRoot, inputs, targetDir }) {
  const template = join(canonicalRoot, "project-template");
  if (!existsSync(template))
    throw new InitError(`${canonicalRoot} is not a canonical Flow checkout — no project-template/ inside it`);
  const versionPath = join(canonicalRoot, "VERSION");
  if (!existsSync(versionPath))
    throw new InitError(`${canonicalRoot} has no VERSION stamp — refusing to write .flow/VERSION from a guess`);

  const files = [];
  const add = (path, contents, kind = "copy") =>
    files.push({ path, kind, contents: Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8") });

  // .flow/ — everything except the three files this tool owns, and the sample task.
  for (const rel of walkFiles(join(template, ".flow"))) {
    if (rel === "config.yml" || rel === "VERSION" || rel === "board.html") continue;
    if (rel.startsWith("tasks/") && rel !== "tasks/_TEMPLATE.md") continue;
    add(`.flow/${rel}`, readFileSync(join(template, ".flow", rel)));
  }
  add(".flow/config.yml", renderConfig(inputs));
  add(".flow/VERSION", readFileSync(versionPath));
  const boardPath = join(template, ".flow", "board.html");
  if (existsSync(boardPath)) add(".flow/board.html", prepareBoard(readFileSync(boardPath, "utf8"), inputs.repo));

  // .claude/ — skills, agents and the committed settings, verbatim.
  const claudeDir = join(template, ".claude");
  if (existsSync(claudeDir))
    for (const rel of walkFiles(claudeDir)) add(`.claude/${rel}`, readFileSync(join(claudeDir, rel)));

  // The thin callers. The COUNT is whatever canonical ships — never a number written down here.
  // (INIT.md once claimed six because someone counted by hand and canonical grew three more.)
  const wfDir = join(template, ".github", "workflows");
  const callers = existsSync(wfDir)
    ? readdirSync(wfDir).filter((n) => /^flow-.+\.ya?ml$/.test(n)).sort()
    : [];
  if (!callers.length)
    throw new InitError(`${template}/.github/workflows holds no flow-*.yml callers — refusing to initialise a repo with no gate`);
  for (const name of callers)
    add(`.github/workflows/${name}`, repin(readFileSync(join(wfDir, name), "utf8"), inputs.canonical));

  for (const e of readdirSync(template, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
    if (e.isFile() && !ROOT_EXCLUDE.has(e.name)) add(e.name, readFileSync(join(template, e.name)));

  const ignorePath = join(template, ".gitignore");
  if (existsSync(ignorePath)) {
    const targetIgnore = join(targetDir, ".gitignore");
    add(".gitignore", mergeGitignore(
      existsSync(targetIgnore) ? readFileSync(targetIgnore, "utf8") : null,
      readFileSync(ignorePath, "utf8"),
    ), "merge");
  }

  return { files, callers, stamp: readFileSync(versionPath, "utf8").trim() };
}

// Split the plan against what is already on disk. `differs` is the only interesting bucket: it is
// the set of files a run would OVERWRITE, which is exactly what --force exists to authorise.
export function classify(files, targetDir) {
  const creates = [], differs = [], unchanged = [], merges = [];
  for (const f of files) {
    const p = join(targetDir, f.path);
    if (!existsSync(p)) creates.push(f.path);
    else if (readFileSync(p).equals(f.contents)) unchanged.push(f.path);
    else if (f.kind === "merge") merges.push(f.path);   // additive by construction — see mergeGitignore
    else differs.push(f.path);
  }
  return { creates, differs, unchanged, merges };
}

// Writes only the files whose bytes would change — an unchanged file is left alone so its mtime
// stays honest about when adoption last altered it.
export function applyPlan(files, targetDir) {
  for (const f of files) {
    const p = join(targetDir, f.path);
    if (existsSync(p) && readFileSync(p).equals(f.contents)) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.contents);
  }
}

// The ONLY function that touches the network, and only when `--from` is absent. Tests and CI pass
// a local checkout; nothing else in this file knows whether the tree arrived over the wire.
export function resolveCanonical({ from, repo, ref }, run = spawnSync) {
  if (from) {
    const dir = resolve(from);
    if (!existsSync(dir)) throw new InitError(`--from ${from}: no such directory`);
    return dir;
  }
  const dir = join(mkdtempSync(join(tmpdir(), "flow-canonical-")), "flow");
  const r = run("git", ["clone", "--depth", "1", "--branch", ref, `https://github.com/${repo}`, dir],
    { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0)
    throw new InitError(`git clone ${repo}@${ref} failed (exit ${r.status}): ${(r.stderr || "").trim()}`);
  return dir;
}

// ── run ────────────────────────────────────────────────────────────────────────────────

const USAGE = `flow-init — the mechanical half of Flow adoption (INIT.md steps 1-4)

  node flow-init.mjs --config init.json [--target DIR] [--dry-run] [--force]

Inputs (flags override --config; the JSON is shaped like .flow/config.yml):
  --name --language --description   project identity                       REQUIRED
  --repo owner/repo                 this repo, for the board's link        REQUIRED
  --install --build --lint --test --coverage   the five gate commands      REQUIRED
  --coverage-min N                  measured floor, never a round guess    REQUIRED
  --source-root "src/=npm run lint" repeatable; must exist in the target   REQUIRED
  --security-focus TEXT             repeatable; defaults to the generic three
  --canonical-repo / --canonical-ref  where the reusables come from (default ${DEFAULT_CANONICAL_REPO}@${DEFAULT_CANONICAL_REF})
  --from DIR                        use a canonical checkout on disk instead of cloning
  --target DIR                      the repo to initialise (default: cwd)
  --dry-run                         print the plan, write nothing
  --force                           overwrite files that differ from the plan

The --config file, for the same inputs as JSON (flags win where both are given):

  {
    "project": { "name": "acme", "language": "typescript", "description": "one line" },
    "repo": "acme-co/storefront",
    "commands": { "install": "npm ci", "build": "npm run build", "lint": "npm run lint",
                  "test": "npm test", "coverage": "npm run coverage" },
    "coverage_min": 81.5,
    "source_roots": [{ "path": "src/", "check": "npm run lint" }],
    "security": { "focus": ["row-level security policies"] },
    "canonical": { "repo": "CandidDan/flow", "ref": "v1" }
  }

Exits 0 (written / dry run / already identical), 1 (bad input), 3 (differences, no --force).`;

export function runInit(argv, {
  log = console.log, logErr = console.error, cwd = process.cwd(), fetchCanonical = resolveCanonical,
} = {}) {
  const { inputs, errors: argErrors } = loadInputs(argv);
  if (inputs.help) { log(USAGE); return 0; }

  const targetDir = resolve(cwd, inputs.target || ".");
  const errors = [...argErrors, ...validateInputs(inputs, { targetDir })];
  if (errors.length) {
    logErr("flow-init: refusing to run — nothing written.");
    for (const e of errors) logErr(`  FAIL  ${e}`);
    return 1;
  }

  let plan;
  try {
    const canonicalRoot = fetchCanonical({ from: inputs.from, repo: inputs.canonical.repo, ref: inputs.canonical.ref });
    plan = { root: canonicalRoot, ...buildPlan({ canonicalRoot, inputs, targetDir }) };
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    logErr(`flow-init: ${e.message}`);
    return 1;
  }

  const { creates, differs, unchanged, merges } = classify(plan.files, targetDir);
  const verb = inputs.dryRun ? "would write" : "writing";

  log(`flow-init: ${inputs.dryRun ? "plan (dry run)" : "initialising"} ${targetDir}`);
  log(`  canonical  ${inputs.canonical.repo}@${inputs.canonical.ref}  (${plan.root})`);
  log(`  stamp      .flow/VERSION -> ${plan.stamp}`);
  log(`  callers    ${plan.callers.length} pinned @${inputs.canonical.ref}: ${plan.callers.join(", ")}`);
  if (inputs.security.defaulted)
    log("  note       security.focus not supplied — wrote the generic defaults; tailor them in .flow/config.yml");
  for (const p of creates) log(`  create     ${p}`);
  for (const p of merges) log(`  merge      ${p}`);
  for (const p of differs) log(`  ${inputs.force ? "overwrite " : "DIFFERS   "} ${p}`);
  for (const p of unchanged) log(`  unchanged  ${p}`);

  if (inputs.dryRun) {
    log(`flow-init: ${creates.length + merges.length + differs.length} file(s) ${verb}. Nothing written (--dry-run).`);
    return 0;
  }

  if (differs.length && !inputs.force) {
    logErr(`flow-init: ${differs.length} file(s) already differ from this plan — nothing written.`);
    for (const p of differs) logErr(`  FAIL  ${p} differs (re-run with --force to overwrite, or reconcile by hand)`);
    return 3;
  }

  if (!creates.length && !differs.length && !merges.length) {
    log("flow-init: already initialised at this ref and byte-identical — nothing to do.");
    return 0;
  }

  applyPlan(plan.files, targetDir);
  log(`flow-init: wrote ${creates.length + merges.length + differs.length} file(s). Next: INIT.md steps 5+ (repo settings, seed tasks, gate-green the baseline).`);
  return 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────
if (__isMain) {
  process.exit(runInit(process.argv.slice(2)));
}
