#!/usr/bin/env node
// source-roots.mjs — the `source_roots:` block of `.flow/config.yml`, parsed once and used twice.
//
// WHY THIS FILE EXISTS. `source_roots` has always declared every tree that holds source and the
// command that parses it, but only flow-doctor ever read it, and only to prove each entry exists
// on disk. Nothing RAN those checks. A repo with a second runtime — Deno edge functions, an MCP
// server, a mobile app — therefore dropped out of the thin-caller model and hand-wrote a job per
// tree in its own `.github/workflows/flow-gates.yml`: near-identical jobs, unpushable by a worker
// credential (no Workflows: Write), and overwritten by the next `flow-sync`. After flow-0077,
// gating a tree is a `.flow/config.yml` edit that any worker can push.
//
// ONE PARSER, NOT TWO. `parseSourceRoots` used to be a private line-scan inside flow-doctor.
// Two parsers of one block drift, and the copy that drifts is the one nobody is testing, so the
// scan lives here and flow-doctor imports it. Its behaviour for the fields flow-doctor reads
// (`path`, `check`) is unchanged; this file only adds fields flow-doctor ignores.
//
// STILL NO YAML DEPENDENCY. The scan is line-based for the same reason it always was: these
// helpers run in `_flow-gates.yml`'s jobs with no install step, so `yaml` is not importable, and
// canonical ships as source that others copy — every dependency added here is imposed downstream.
//
//   node .flow/bin/source-roots.mjs plan   # prints `matrix=<json>` and `count=<n>`
//   node .flow/bin/source-roots.mjs run    # runs one entry's check, from FLOW_SOURCE_ROOT_*
//
// THE SCHEMA, and why it is this small. Per entry: `path` and `check` (required, as before) plus
// three optional fields — `runtime`, `version`, `retry`. Each is optional and each has a default,
// so a second consumer can extend the set without breaking anyone, and an entry written before
// flow-0077 keeps working untouched. Anything else is an ERROR rather than an ignored key: a
// silently-dropped `retires: 1` typo is a check that quietly never retries.
//
// WHAT IS DELIBERATELY ABSENT. There is no escape-hatch field — no `env:`, no extra steps, no
// `runs-on`. A repo whose need still doesn't fit keeps its own hand-written job, and flow-0076
// stops `flow-sync` from deleting it. An escape hatch here would be a second, worse workflow
// language embedded in a config file.

import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────────────────
// The schema
// ─────────────────────────────────────────────────────────────────────────────────────────

// The sentinel `project-template/.flow/config.yml` ships in `source_roots[].path` / `.check` —
// documented, load-bearing behaviour (`INIT.md` rule 1: never invent a config value) that marks
// a repo as not-yet-calibrated rather than drifted. Trailing slashes on `path` are stripped
// before comparing, so `"REPLACE-ME/"` and `"REPLACE-ME"` both match.
export const PLACEHOLDER = "REPLACE-ME";
export function isPlaceholder(v) {
  return String(v ?? "").replace(/\/+$/, "") === PLACEHOLDER;
}

// Every field an entry may carry. An unknown key fails `plan` naming the entry and the key.
export const ENTRY_FIELDS = Object.freeze(["path", "check", "runtime", "version", "retry"]);

// `none` means "no setup step" — the check provisions its own toolchain (a `uv sync`, a
// `bundle install`, a container). It is the honest answer for a stack Flow does not model,
// and it is why this list does not need to grow every time someone adopts a new language.
//
// `node` additionally runs the repo's `commands.install` before the check (flow-0097). Before
// that, a `runtime: node` job did `setup-node` and nothing else, so a check as ordinary as
// `npm run lint` exited 127 in any repo whose linter is a devDependency — the repo had already
// declared how to install itself and the job ignored it. `deno` and `none` are unchanged.
export const RUNTIMES = Object.freeze(["node", "deno", "none"]);
export const DEFAULT_RUNTIME = "node";
export const DEFAULT_VERSIONS = Object.freeze({ node: "22", deno: "v2.x" });

// Capped at 3 on purpose. `retry` exists for a genuinely flaky external dependency (Nudge's
// remote-module loader race); an unbounded count would let a check that is simply broken pass
// as merely flaky, which is the one failure this whole gate exists to prevent.
export const MAX_RETRY = 3;
export const DEFAULT_RETRY = 0;

// The four `commands.*` the `gate` job already runs. An entry whose `check` is exactly one of
// these — or exactly one `&&`-separated segment of one — is left out of the matrix. See
// `primaryChecks` and `planSourceRoots`.
export const PRIMARY_COMMAND_KEYS = Object.freeze(["build", "lint", "test", "coverage"]);

/**
 * Every command string the `gate` job is already known to run, as a Set.
 *
 * WHY SEGMENTS (flow-0097). A repo whose `commands.lint` is `npm run lint && npm run typecheck`
 * and whose source_roots each declare `check: "npm run lint"` used to get a job per tree
 * re-running a command the `gate` job had just run over the whole repo — three redundant jobs on
 * every PR, because the match was whole-string equality and the whole string was the pair.
 * `&&` is unconditional-on-success sequencing, so every segment of a primary command that the
 * gate job ran to completion did run; matching a segment is therefore sound, not a guess.
 *
 * DELIBERATELY ONLY `&&`. No `;`, no `||`, no pipes, no subshells — those are parsed as ordinary
 * text and stay part of whichever segment they fall in. `a; b` and `a || b` are each ONE entry in
 * this set, so neither `a` nor `b` alone counts as covered. The cost of being wrong here is a
 * tree that silently stops being gated, which is the exact failure the whole job exists to
 * prevent; a redundant job is merely slow. When in doubt this must run the check.
 */
export function primaryChecks(commands = {}) {
  const out = new Set();
  for (const key of PRIMARY_COMMAND_KEYS) {
    const command = commands[key];
    if (!command) continue;
    out.add(command);                                // the whole command, exactly as before
    for (const segment of command.split("&&")) {
      const s = segment.trim();
      if (s) out.add(s);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The parser (moved here from flow-doctor — behaviour for `path`/`check` unchanged)
// ─────────────────────────────────────────────────────────────────────────────────────────

// Strip a trailing `# comment`, surrounding whitespace and one layer of quotes.
function unquote(v) {
  return v.split("#")[0].trim().replace(/^["'](.*)["']$/, "$1");
}

// `key: value` on an already-trimmed line, with the optional leading list dash split off.
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/;

/**
 * Parse the `source_roots:` block from config.yml without a YAML dep. Tolerant line scan of:
 *   source_roots:
 *     - path: "app/"
 *       check: "npm run lint"
 *       runtime: "deno"      # optional
 *
 * Each root carries `path` and `check` (always present, `""` when absent) plus `fields`: the
 * raw key→value map exactly as written, which is what lets `plan` report an unknown key. Only a
 * leading `-` starts a new entry (a bare `-` on its own line included), so an entry's keys may
 * come in any order — `path` does not have to be first.
 */
export function parseSourceRoots(configPath) {
  if (!existsSync(configPath)) return { exists: false, declared: false, roots: [] };
  const lines = readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((l) => /^source_roots:/.test(l));
  if (start === -1) return { exists: true, declared: false, roots: [] };
  const roots = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;                     // dedent to a new top-level key → block done
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const dash = trimmed.match(/^-\s*(.*)$/);
    // The dash alone starts an entry — including a bare `-` on its own line, whose keys follow.
    // A key never does: `- runtime: …` then `path: …` is one entry, whatever order it is written in.
    if (dash) { cur = { path: "", check: "", fields: {} }; roots.push(cur); }
    const kv = KEY_RE.exec(dash ? dash[1] : trimmed);
    if (!kv) continue;                               // a bare `-`, or something we don't model
    const [, key, rawValue] = kv;
    if (!cur) continue;                              // a key before any entry started
    const value = unquote(rawValue);
    cur.fields[key] = value;
    if (key === "path" || key === "check") cur[key] = value;
  }
  return { declared: true, roots };
}

/**
 * Parse the `commands:` block — the same tolerant line scan, one level of nesting, no list.
 * Returns a plain `{ install, build, lint, test, coverage }`-shaped object of whatever is there.
 */
export function parseCommands(configPath) {
  if (!existsSync(configPath)) return {};
  const lines = readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((l) => /^commands:/.test(l));
  if (start === -1) return {};
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const kv = KEY_RE.exec(trimmed);
    if (kv) out[kv[1]] = unquote(kv[2]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────────────────────────────────

// How an entry is named in an error, so the human can find the line. `path` when it has one,
// otherwise its 1-based position in the block.
function label(root, index) {
  return root.path ? `source_root "${root.path}"` : `source_root #${index + 1}`;
}

/**
 * Decide which declared `source_roots` need a job of their own, and validate every entry's
 * schema. Returns `{ matrix, count, excluded, errors }` — `errors` non-empty means `plan` exits
 * non-zero and nothing runs, because a config this job cannot read is not a config it may
 * guess at.
 *
 * Two kinds of entry are EXCLUDED rather than rejected:
 *   · uncalibrated — `path` or `check` still holds the shipped `REPLACE-ME` sentinel. A repo
 *     mid-adoption must not have its gate fail on a placeholder it was told to leave alone.
 *   · already covered — `check` equals `commands.build`, `.lint`, `.test` or `.coverage`, or one
 *     `&&`-separated segment of one (see `primaryChecks`), all of which the `gate` job already
 *     runs. Canonical's own four entries are all `npm run lint` / `npm run build`, so canonical's
 *     matrix is empty BY DESIGN; without this rule every PR here would re-run lint three times
 *     for nothing.
 *
 * Every surviving row also carries `install`: the repo's `commands.install` for a `runtime: node`
 * entry, and `""` otherwise (a non-node runtime, an absent `commands.install`, or a REPLACE-ME
 * one). `""` is the workflow's signal to skip its install step entirely.
 */
export function planSourceRoots({ configPath, repoRoot = dirname(dirname(configPath)) } = {}) {
  const { declared, roots } = parseSourceRoots(configPath);
  const commands = parseCommands(configPath);
  const primary = primaryChecks(commands);

  // The repo's own `commands.install`, or "" when it is absent or still the shipped sentinel.
  // Emitted on every matrix row so the shape stays uniform; the workflow's install step is
  // guarded on `matrix.runtime == 'node' && matrix.install != ''`, so "" means "skip the step".
  const declaredInstall = commands.install ?? "";
  const install = declaredInstall && !isPlaceholder(declaredInstall) ? declaredInstall : "";

  const errors = [];
  const excluded = [];
  const matrix = [];
  if (!declared) return { matrix, count: 0, excluded, errors };

  roots.forEach((root, i) => {
    const who = label(root, i);
    const errorsBefore = errors.length;

    // Schema first, and for EVERY entry — including ones that are about to be excluded. An
    // unknown key in a placeholder entry is still a typo the author wants to hear about, and
    // validating only what runs would let a broken field hide until the day it is calibrated.
    for (const key of Object.keys(root.fields)) {
      if (!ENTRY_FIELDS.includes(key)) {
        errors.push(`${who}: unknown field "${key}" — source_roots entries take only ` +
          `${ENTRY_FIELDS.join(", ")}. A field this block does not model is silently ignored ` +
          "otherwise, which is how a typo becomes an ungated tree.");
      }
    }

    const runtime = root.fields.runtime ?? DEFAULT_RUNTIME;
    if (!RUNTIMES.includes(runtime)) {
      errors.push(`${who}: field "runtime" is "${runtime}" — must be one of ${RUNTIMES.join(", ")}. ` +
        "Use `none` for a stack that provisions its own toolchain inside the check.");
    }

    const rawRetry = root.fields.retry;
    let retry = DEFAULT_RETRY;
    if (rawRetry !== undefined) {
      if (!/^-?\d+$/.test(rawRetry.trim())) {
        errors.push(`${who}: field "retry" is "${rawRetry}" — must be a whole number ` +
          `between 0 and ${MAX_RETRY}.`);
      } else {
        retry = Number(rawRetry.trim());
        if (retry < 0 || retry > MAX_RETRY) {
          errors.push(`${who}: field "retry" is ${retry} — must be between 0 and ${MAX_RETRY}. ` +
            "The cap is deliberate: an unbounded retry lets a broken check pass as merely flaky.");
        }
      }
    }

    // An entry whose schema did not validate contributes no matrix row. `plan` is about to exit
    // non-zero anyway, but a half-built matrix in the return value is a trap for any caller that
    // reads `matrix` without checking `errors` first.
    if (errors.length > errorsBefore) return;

    if (isPlaceholder(root.path) || isPlaceholder(root.check)) {
      excluded.push({ path: root.path, reason: "uncalibrated" });
      return;
    }
    if (!root.path) {
      errors.push(`${who}: field "path" is empty — declare the tree this check parses.`);
      return;
    }
    if (!root.check) {
      errors.push(`${who}: field "check" is empty — declare the command that parses this tree.`);
      return;
    }
    if (primary.has(root.check)) {
      excluded.push({ path: root.path, reason: "covered by the primary gate" });
      return;
    }

    // `version` is ignored for `none` — there is no setup step to give it to — and emitted as
    // the empty string so the matrix shape stays uniform.
    const version = runtime === "none" ? "" : (root.fields.version ?? DEFAULT_VERSIONS[runtime] ?? "");

    // The npm cache keys on this tree's OWN lockfile, and only when it has one. A repo whose
    // second tree vendors no lockfile gets no cache rather than a cache keyed on the wrong file.
    const lock = join(root.path, "package-lock.json");
    const cacheable = runtime === "node" && existsSync(join(repoRoot, lock));

    matrix.push({
      path: root.path,
      check: root.check,
      runtime,
      version,
      retry,
      cache: cacheable ? "npm" : "",
      cache_dependency_path: cacheable ? lock : "",
      // flow-0097: `runtime: node` installs the repo's declared dependencies before the check.
      // `deno` and `none` get "" — `none` means "the check provisions its own toolchain", and
      // giving a Deno tree an `npm ci` would be inventing a step its config never asked for.
      install: runtime === "node" ? install : "",
    });
  });

  return { matrix, count: matrix.length, excluded, errors };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run one entry's check from the repo root, up to `1 + retry` times, exiting with the LAST
 * attempt's status. Every attempt is logged, and so is which one succeeded — a retry that
 * hides how many goes it took is a flaky check with the evidence removed.
 *
 * The check is a shell command string exactly as written in config.yml (`cd mcp && npm ci &&
 * npm run build`), run from the repo root — the same convention `commands.*` uses. That means
 * `shell: true`, and it is the same trust posture the `gate` job already has: the config is the
 * repo's own. What must NEVER happen is the command reaching a workflow `run:` block through
 * `${{ matrix.check }}`, where it would be pasted into the runner's shell before this process
 * ever sees it — hence the env-var CLI below.
 */
export function runCheck({ check, retry = DEFAULT_RETRY, cwd, log = console.log, spawn = spawnSync }) {
  const attempts = 1 + Math.max(0, Number(retry) || 0);
  let status = 0;
  for (let n = 1; n <= attempts; n++) {
    log(`source-roots: attempt ${n}/${attempts} — ${check}`);
    const r = spawn(check, { cwd, shell: true, stdio: "inherit" });
    status = r.status === null || r.status === undefined ? 1 : r.status;
    if (status === 0) {
      log(`source-roots: attempt ${n}/${attempts} succeeded`);
      return 0;
    }
    log(`source-roots: attempt ${n}/${attempts} failed (exit ${status})`);
  }
  log(`source-roots: all ${attempts} attempt(s) failed (exit ${status})`);
  return status;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// CLI — shared by the template and by canonical's adapter, which supplies only the store
// ─────────────────────────────────────────────────────────────────────────────────────────

// GitHub Actions' `$GITHUB_OUTPUT` protocol, plus stdout so a local run shows the same thing.
function emit(name, value, out) {
  const line = `${name}=${value}`;
  out.stdout(line);
  if (out.githubOutput) out.appendOutput(line + "\n");
}

/**
 * `plan` and `run`, over an injected store. Returns the process exit code; it never calls
 * `process.exit`, so a test can drive it.
 */
export function main(argv, {
  configPath,
  repoRoot,
  env = process.env,
  stdout = (s) => console.log(s),
  stderr = (s) => console.error(s),
  appendOutput = null,
  spawn = spawnSync,
} = {}) {
  const [cmd] = argv;

  if (cmd === "plan") {
    const { matrix, count, excluded, errors } = planSourceRoots({ configPath, repoRoot });
    for (const e of errors) stderr(`::error::${e}`);
    if (errors.length) return 1;
    for (const x of excluded) stderr(`source-roots: skipping "${x.path}" — ${x.reason}`);
    const out = {
      stdout,
      githubOutput: !!env.GITHUB_OUTPUT,
      appendOutput: appendOutput ?? ((s) => appendFileSync(env.GITHUB_OUTPUT, s)),
    };
    emit("matrix", JSON.stringify({ include: matrix }), out);
    emit("count", String(count), out);
    return 0;
  }

  if (cmd === "run") {
    // Values arrive through the environment, never through `${{ }}` interpolation into a
    // `run:` block. argv is accepted too, for running one tree's check by hand.
    const check = argv[1] ?? env.FLOW_SOURCE_ROOT_CHECK ?? "";
    const retry = argv[2] ?? env.FLOW_SOURCE_ROOT_RETRY ?? String(DEFAULT_RETRY);
    if (!check) {
      stderr("::error::source-roots run: no check given — set FLOW_SOURCE_ROOT_CHECK " +
        "(or pass it as an argument).");
      return 1;
    }
    const where = env.FLOW_SOURCE_ROOT_PATH || "";
    if (where) stdout(`source-roots: gating "${where}" from ${repoRoot}`);
    return runCheck({ check, retry, cwd: repoRoot, log: stdout, spawn });
  }

  stderr("usage: source-roots.mjs plan | run [<check> [<retry>]]");
  return 2;
}

// ── The repo-root contract (flow-0094, ADR-0008) ─────────────────────────────────────────
//
// `_flow-gates.yml` no longer runs the CALLER's copy of this helper. It fetches canonical's
// `project-template/.flow/bin/` at the running workflow's own commit (`job.workflow_sha`) and runs
// THAT — so a release that changes a workflow and its helper together reaches CI as one unit,
// instead of breaking every pinned repo until its flow-sync PR merges.
//
// Which makes the default below actively dangerous in CI: run from a canonical checkout under
// `$RUNNER_TEMP`, `templateRepoRoot()` resolves to CANONICAL's `project-template/`, whose
// `.flow/config.yml` is the uncalibrated REPLACE-ME fixture — and every command still exits 0.
// A green gate that measured the wrong repo is worse than the red one it replaces, because it is
// silent. So the converted steps pass the target explicitly, and in CI mode the absence of that
// value is an error rather than a fallback.
//
// IT LIVES IN THIS FILE, and the two sibling helpers import it, because this is the helper that
// already owns the gate's `FLOW_*` environment contract (`FLOW_SOURCE_ROOT_*` above). One
// implementation, three callers — the same rule the adapters follow.
export const REPO_DIR_ENV = "FLOW_REPO_DIR";
export const CI_MODE_ENV = "FLOW_CI";

/**
 * Resolve the repo a helper must operate on.
 *
 * - `FLOW_REPO_DIR` set → that path wins, always. It is how a helper run from outside the repo
 *   is told which repo it is judging.
 * - `FLOW_CI` set without it → `{ error }`, naming the variable. Never a silent fallback.
 * - Neither set → `fallback()`, i.e. the module-relative default. This is the local-run path,
 *   and it is also what a repo still pinned to an OLDER `_flow-gates.yml` uses: that workflow
 *   sets neither variable, and it must keep working, or this change is the 2.1.x break with the
 *   halves swapped. That is why `FLOW_CI` is an explicit opt-in and not `GITHUB_ACTIONS`.
 *
 * Returns `{ repoRoot, explicit }` or `{ error }`; it never throws and never exits. `explicit`
 * is what a caller `chdir`s on: being TOLD which repo to read is the only case where moving the
 * process out of the directory a human invoked it from is right. On the fallback path the cwd is
 * already the answer, and changing it would break every local and test invocation.
 */
export function resolveRepoRoot({ env = process.env, fallback = () => process.cwd() } = {}) {
  const given = (env[REPO_DIR_ENV] || "").trim();
  if (given) return { repoRoot: resolve(given), explicit: true };
  if ((env[CI_MODE_ENV] || "").trim()) {
    return {
      error: `::error::${CI_MODE_ENV} is set but ${REPO_DIR_ENV} is not. A Flow reusable is ` +
        `running this helper from canonical's own checkout, so it cannot infer which repo to ` +
        `read — falling back to its own directory would silently check canonical's fixtures ` +
        `and exit 0. Set ${REPO_DIR_ENV} to the repo root (the converted steps pass ` +
        `\${{ github.workspace }}). See docs/adr/0008-helpers-from-canonical.md.`,
    };
  }
  return { repoRoot: fallback(), explicit: false };
}

// The tree this file governs: `<root>/.flow/bin/source-roots.mjs` → `<root>`. Resolved from the
// REALPATH of this module, which is why a symlinked `.flow/bin` would read the wrong store.
export function templateRepoRoot(here = fileURLToPath(import.meta.url)) {
  return resolve(dirname(realpathSync(here)), "..", "..");
}
export function templateConfigPath(here = fileURLToPath(import.meta.url)) {
  return join(templateRepoRoot(here), ".flow", "config.yml");
}

// --- main-module detection (do not simplify back to a string compare) -------------------
const __isMain = (() => {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
// ---------------------------------------------------------------------------------------

if (__isMain) {
  const { repoRoot, error, explicit } = resolveRepoRoot({ fallback: templateRepoRoot });
  if (error) {
    console.error(error);
    process.exit(1);
  }
  // `chdir` only when told: it makes the `check` subprocess, and any `git` that check shells out
  // to, see the target repo rather than the canonical checkout this file was loaded from.
  if (explicit) process.chdir(repoRoot);
  process.exit(main(process.argv.slice(2), {
    configPath: join(repoRoot, ".flow", "config.yml"),
    repoRoot,
  }));
}
