// Tests for flow-doctor — the store validator validates itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, lstatSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runDoctor, parseSourceRootsIgnore, compareVersions, duplicateIdProblems, filenameTaskId, findUncommittedTasks, parseVisionGoals, readinessFindings, blockedByFindings, isBlockedByEntry, asksFindings, intentFindings, evidenceShape, INTENT_REQUIRED, INTENT_STATUSES, taskIntentFindings, parseIntentsRequiredFrom, INTENTS_REQUIRED_FROM_KEY } from "./flow-doctor.mjs";

// The vision every fixture gets unless it asks for none: two live goals, one non-goal, one
// retired goal. Written in the shape flow-doctor's line regex reads, deliberately mixing the
// em dash and the hyphen — humans type both, and the checker has to survive that.
const VISION = `# Vision — the fixture repo

## Goals

### G1 — Ship the thing
Because the thing is the point.

### G2 - Ship the other thing

## Non-goals

### NG1 — Become a project-management product

## Retired

### G9 — The thing we stopped doing
Retired 2026-08-18: superseded by G1.
`;

// A body that meets the readiness bar: the three required sections and one real criterion.
const READY_BODY = `
## Context

Why this task exists, in enough detail that a fresh session doesn't have to ask.

## Scope

What it changes, and what it deliberately leaves alone.

## Acceptance criteria

- [ ] Given a drifted store, when flow-doctor runs, then it names the task and the drift.

## Notes / open questions

None.
`;

// A repo-shaped fixture — <repo>/.flow/tasks/… — so every check that keys off the repo root
// (VISION.md, the new-subsystem tell, source_roots) sees only what the test created, and not
// whatever happens to sit in the system temp dir.
//   dirs    top-level dirs to materialise. Defaults to the root the default `touches` points
//           at, so the new-subsystem warning fires only where a test deliberately omits one.
//   vision  VISION.md content, or null for a repo that has no vision at all.
//   intents `{ name: contents }` written into `.flow/intents/`, or null for a repo with no
//           intent store at all. Defaults to an EMPTY STORE rather than no store, for the same
//           reason `vision` defaults to a real vision: the absent-store warning is a fact about
//           adoption, and a fixture that tripped it by accident would bury it under noise in
//           every unrelated assertion about warnings.
//   requiredFrom  `intents.required_from` written to `.flow/config.yml` — or null for no config
//           file at all, the "store present, key unset" case. Defaults to a date before every
//           fixture task's `created` (which `task()` leaves empty unless asked), for the same
//           reason: a repo that has adopted intents properly, so the one-off unset-key warning
//           only appears where a test asks for it. Only written when there is an intent store.
//           `source_roots: []` keeps the gate-coverage nudge quiet without declaring a root.
function fixture(files, { dirs = ["src"], vision = VISION, intents = {}, requiredFrom = "2026-01-01" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "flow-doc-"));
  mkdirSync(join(repo, ".flow", "tasks"), { recursive: true });
  for (const d of dirs) mkdirSync(join(repo, d), { recursive: true });
  if (vision !== null) writeFileSync(join(repo, "VISION.md"), vision);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, ".flow", "tasks", name), body);
  if (intents !== null) {
    mkdirSync(join(repo, ".flow", "intents"), { recursive: true });
    for (const [name, body] of Object.entries(intents)) writeFileSync(join(repo, ".flow", "intents", name), body);
    if (requiredFrom !== null) {
      writeFileSync(join(repo, ".flow", "config.yml"),
        `source_roots: []\nintents:\n  required_from: "${requiredFrom}"\n`);
    }
  }
  return join(repo, ".flow");
}

// An intent file in the shape `.flow/intents/_TEMPLATE.md` ships.
//   omit        field names to leave out entirely (undefined, not empty) — the missing-field case
//   evidence    raw YAML for the value; null omits the key altogether
//   serves      raw YAML for the value; omitted entirely when not given, which is the shape of
//               every intent written before flow-0073 added the field
//   supersedes  the id this intent replaces; omitted entirely when not given
//   body        extra Markdown appended after the Outcome section
const intent = (id, f = {}) => {
  const fields = {
    id: `"${id}"`,
    title: `"${f.title ?? "Stop losing the thread between sessions"}"`,
    status: `"${f.status ?? "proposed"}"`,
    created: `"${f.created ?? "2026-09-17"}"`,
    source: `"${f.source ?? "Dan, interviewed 2026-09-17"}"`,
    approved_by: `"${f.approved_by ?? ""}"`,
    approved_at: `"${f.approved_at ?? ""}"`,
  };
  if (f.serves !== undefined) fields.serves = f.serves;
  if (f.supersedes !== undefined) fields.supersedes = `"${f.supersedes}"`;
  for (const k of f.omit ?? []) delete fields[k];
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  if (f.evidence !== null) lines.push(`evidence: ${f.evidence ?? "[]"}`);
  return `---\n${lines.join("\n")}\n---\n\n## Problem\n\nTheir words.\n\n## Outcome\n\nWhat changes for them.\n${f.body ?? ""}`;
};
// Removes the whole fixture repo, not just the `.flow` inside it.
const cleanup = (flowDir) => rmSync(dirname(flowDir), { recursive: true, force: true });

const task = (id, f = {}) => `---
id: "${id}"
title: "${f.title ?? "x"}"
status: "${f.status ?? "ready"}"
priority: ${f.priority ?? 3}
owner: "${f.owner ?? ""}"
started: "${f.started ?? ""}"
branch: "${f.branch ?? ""}"
pr: "${f.pr ?? ""}"
blocked_reason: "${f.blocked_reason ?? ""}"
${f.created === undefined ? "" : `created: "${f.created}"\n`}${f.intent === undefined ? "" : `intent: "${f.intent}"\n`}${f.blocked_by === undefined ? "" : `blocked_by: ${f.blocked_by}\n`}${f.asks === undefined ? "" : `asks:\n${f.asks.map((a) => `  - ${JSON.stringify(a)}`).join("\n")}\n`}serves: ${f.serves ?? '["G1"]'}
touches: ${f.touches ?? '["src/**"]'}
---
${f.body ?? READY_BODY}`;

test("healthy store: no problems, no warnings", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.count, 1);
  cleanup(d);
});

test("duplicate ids and illegal status are problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001"),
    "0002-b.md": task("P-0001"),
    "0003-c.md": task("P-0003", { status: "shipping" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("duplicate id")));
  assert.ok(r.problems.some((p) => p.includes('illegal status "shipping"')));
  cleanup(d);
});

test("in_review without pr, blocked without reason, incomplete claim — all problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_review", branch: "flow/P-0001-x" }),       // no pr
    "0002-b.md": task("P-0002", { status: "blocked" }),                                   // no reason
    "0003-c.md": task("P-0003", { status: "in_progress", owner: "sess" }),                // no started
  });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.problems.length, 3);
  cleanup(d);
});

test("ready with stale owner or empty touches — warnings, not problems", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { owner: "sess-old" }),
    "0002-b.md": task("P-0002", { touches: "[]" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.length, 2);
  cleanup(d);
});

test("board snapshot drift is a warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-06-05" }) });
  writeFileSync(join(d, "board.html"),
    `<script>\nconst TASKS = [\n  {id:"P-0001", title:"x", status:"ready", priority:3},\n  {id:"P-9999", title:"ghost", status:"done", priority:3},\n];\n</script>`);
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001=ready, files say in_progress")));
  assert.ok(r.warnings.some((w) => w.includes("P-9999 but no task file")));
  cleanup(d);
});

test("malformed frontmatter and missing fields are problems", () => {
  const d = fixture({
    "0001-a.md": "no frontmatter at all\n",
    "0002-b.md": `---\nid: "P-0002"\nstatus: "ready"\npriority: 3\n---\nbody\n`,   // no title
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("malformed frontmatter")));
  assert.ok(r.problems.some((p) => p.includes("missing required field(s): title")));
  cleanup(d);
});

// ── touches overlap (false "parallel-safe" detection) ──

test("overlapping touches on two ready tasks → warning naming both, not a problem", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '["app/x/**", "app/shared/page.ts"]' }),
    "0002-b.md": task("P-0002", { touches: '["app/y/**", "app/shared/page.ts"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("P-0002") && w.includes("overlapping touches")));
  cleanup(d);
});

test("overlapping touches on two in_progress tasks → problem (atomic-claim bypassed)", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s1", started: "2026-06-05", touches: '["app/shared/**"]' }),
    "0002-b.md": task("P-0002", { status: "in_progress", owner: "s2", started: "2026-06-05", touches: '["app/shared/util.ts"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("P-0002") && p.includes("in_progress")));
  cleanup(d);
});

test("disjoint touches → no overlap warning (different trees are genuinely parallel-safe)", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '["app/whisper/**"]' }),
    "0002-b.md": task("P-0002", { touches: '["app/meetings/**"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("overlapping touches")));
  cleanup(d);
});

test("multi-line touches form parses (not misread as empty) AND feeds overlap — the CAN-42/43 case", () => {
  const ml = (id, p) => `---
id: "${id}"
title: "x"
status: "ready"
priority: 3
owner: ""
started: ""
branch: ""
pr: ""
blocked_reason: ""
serves: ["G1"]
touches:
  - "${p}"
labels: [x]
---
${READY_BODY}`;
  const d = fixture({ "0001-a.md": ml("P-0001", "app/focus/page.tsx"), "0002-b.md": ml("P-0002", "app/focus/page.tsx") });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("empty touches")), "multi-line touches must not read as empty");
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("P-0002") && w.includes("overlapping")), "shared file must be flagged");
  cleanup(d);
});

// ── gate-coverage floor (source_roots) ──
// Repo-shaped fixture: a clean root holding .flow/ + arbitrary source trees, so the scan
// (which keys off dirname(flowDir)) sees only what we create.
function repoFixture({ config, trees = {} }) {
  const repo = mkdtempSync(join(tmpdir(), "flow-repo-"));
  mkdirSync(join(repo, ".flow", "tasks"), { recursive: true });
  writeFileSync(join(repo, ".flow", "tasks", "0001-a.md"), task("P-0001"));
  if (config !== undefined) writeFileSync(join(repo, ".flow", "config.yml"), config);
  for (const [path, file] of Object.entries(trees)) {
    mkdirSync(join(repo, path), { recursive: true });
    writeFileSync(join(repo, path, file), "export const x = 1;\n");
  }
  return { repo, flowDir: join(repo, ".flow") };
}
const cfg = (roots) =>
  "source_roots:\n" + roots.map((r) => `  - path: "${r.path}"\n    check: "${r.check ?? ""}"`).join("\n") + "\n";

test("source_roots: every tree declared + covered → clean", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }, { path: "supabase/functions/", check: "deno check supabase/functions/**/*.ts" }]),
    trees: { "app/src": "index.ts", "supabase/functions/process-inbound": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: an UNDECLARED top-level source tree FAILS (the BOOT_ERROR class)", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }]),               // declares app only
    trees: { "app/src": "index.ts", "supabase/functions/x": "index.ts" }, // supabase/ undeclared
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"supabase/"') && p.includes("not covered")));
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: declared root missing on disk, or with no check → problems", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "" }, { path: "ghost/", check: "x" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"app/" has no check')));
  assert.ok(r.problems.some((p) => p.includes('"ghost/" does not exist')));
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: config present but none declared → adoption warning, not failure", () => {
  const { repo, flowDir } = repoFixture({ config: "project:\n  name: x\n", trees: { "app/src": "index.ts" } });
  const r = runDoctor({ flowDir });
  assert.ok(r.warnings.some((w) => w.includes("no source_roots declared")));
  assert.ok(!r.problems.some((p) => p.includes("source")));
  rmSync(repo, { recursive: true, force: true });
});

// ── uncalibrated vs stale (flow-0017) ──
// A source_root still holding the shipped REPLACE-ME sentinel is "not yet calibrated", not
// "drifted" — it must warn, never fail, and must not let the gate-coverage floor pass silently.

test("source_roots: the shipped REPLACE-ME/REPLACE-ME entry alone → clean exit, one warning naming it", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "REPLACE-ME/", check: "REPLACE-ME" }]),
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes('"REPLACE-ME/"') && /uncalibrated/i.test(w)),
    "no warning names the uncalibrated source_root");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: a real, non-placeholder path missing on disk is still a stale-declaration PROBLEM", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "ghost/", check: "npm run lint" }]),
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"ghost/" does not exist') && /stale declaration/.test(p)));
  assert.ok(!r.warnings.some((w) => /uncalibrated/i.test(w)), "a real stale path must not read as uncalibrated");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: half-calibrated — one real root plus one REPLACE-ME entry — neither goes silent", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }, { path: "REPLACE-ME/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, [], "the real, calibrated root must not fail alongside the placeholder");
  assert.ok(r.warnings.some((w) => w.includes('"REPLACE-ME/"') && /uncalibrated/i.test(w)),
    "the placeholder entry produced no warning — it went silent");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: real, present path but placeholder check → uncalibrated warning, not a silent pass", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes('"app/"') && /uncalibrated/i.test(w)),
    "a REPLACE-ME check on a real path must still warn — the truthy-placeholder hole must stay closed");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: uncalibrated config + an undeclared top-level source tree — the backstop still fires", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "REPLACE-ME/", check: "REPLACE-ME" }]),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p.includes('"app/"') && p.includes("not covered")),
    "the uncalibrated placeholder must not appear to cover a real, undeclared source tree");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots: an entry with an empty path is the existing PROBLEM, not reclassified as uncalibrated", () => {
  const { repo, flowDir } = repoFixture({
    config: 'source_roots:\n  - path: ""\n    check: "npm run lint"\n',
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.problems.some((p) => p === "source_root with no path in config.yml"));
  assert.ok(!r.warnings.some((w) => /uncalibrated/i.test(w)), "an empty path is malformed config, not a placeholder");
  rmSync(repo, { recursive: true, force: true });
});

// ── source_roots_ignore: the repo's half of the ignore set (flow-0102) ──
// ROOT_IGNORE is canonical's, hard-coded, and it is the ONLY escape hatch from the
// undeclared-tree FAIL above — so a repo whose `docs/` or `holding/` holds source-extension
// files but is deliberately ungated could only get green by patching flow-doctor.mjs, which the
// next flow-sync overwrites. These tests hold the config-side hatch open, and hold shut the two
// ways it could rot: an entry that looks like it exempts something and doesn't, and an entry
// that is wrong and says nothing.

// `source_roots:` declaring app/ (present in every fixture below) plus a raw ignore block.
const cfgIgnore = (ignoreYaml) => cfg([{ path: "app/", check: "npm run lint" }]) + ignoreYaml;
const undeclared = (r, dir) => r.problems.filter((p) => p.includes(`"${dir}/"`) && p.includes("not covered"));

test("source_roots_ignore: an ignored top-level tree produces no undeclared-tree failure", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore: ["holding"]\n'),
    trees: { "app/src": "index.ts", holding: "scratch.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(undeclared(r, "holding"), [],
    "a folder the repo declared ignorable must not fail the gate-coverage floor");
  assert.deepEqual(r.problems, [], `an ignored tree is not a problem of any other kind: ${JSON.stringify(r.problems)}`);
  assert.deepEqual(r.warnings.filter((w) => w.includes("source_roots_ignore")), [],
    "a well-formed entry naming a real folder must be silent");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: without the key the same tree still FAILS, and the message names the key", () => {
  const { repo, flowDir } = repoFixture({
    config: cfg([{ path: "app/", check: "npm run lint" }]),
    trees: { "app/src": "index.ts", holding: "scratch.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.equal(undeclared(r, "holding").length, 1, "existing behaviour: an undeclared tree fails");
  assert.match(undeclared(r, "holding")[0], /source_roots_ignore/,
    "the FAIL must name the config key, not ROOT_IGNORE — a fix a repo cannot apply is not a fix");
  assert.doesNotMatch(undeclared(r, "holding")[0], /ROOT_IGNORE/,
    "pointing an adopter at flow-doctor's own constant is what flow-0102 removed");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: an entry with a path separator WARNS naming it and exempts nothing", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore: ["docs/api"]\n'),
    trees: { "app/src": "index.ts", "docs/api": "sample.ts" },
  });
  const r = runDoctor({ flowDir });
  const w = r.warnings.filter((x) => x.includes('"docs/api"'));
  assert.equal(w.length, 1, `expected one warning naming the entry, got ${JSON.stringify(r.warnings)}`);
  assert.match(w[0], /bare top-level folder name/);
  assert.equal(undeclared(r, "docs").length, 1, "a malformed entry must exempt nothing");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: a glob entry WARNS naming it and exempts nothing", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore: ["hold*"]\n'),
    trees: { "app/src": "index.ts", holding: "scratch.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.warnings.some((x) => x.includes('"hold*"') && /glob/.test(x)),
    `expected a warning naming the glob entry, got ${JSON.stringify(r.warnings)}`);
  assert.equal(undeclared(r, "holding").length, 1,
    "the ignore set is matched by name — a pattern must not appear to work");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: an entry naming no folder WARNS naming it, and is never fatal", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore: ["ghost"]\n'),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.warnings.some((x) => x.includes('"ghost"') && /names no folder/.test(x)),
    `expected a stale-entry warning naming it, got ${JSON.stringify(r.warnings)}`);
  assert.deepEqual(r.problems, [], "an unreadable escape hatch must not be able to fail a gate by itself");
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: an empty entry WARNS rather than being silently dropped", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore:\n  - ""\n'),
    trees: { "app/src": "index.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.ok(r.warnings.some((x) => /source_roots_ignore has an empty entry/.test(x)),
    `expected an empty-entry warning, got ${JSON.stringify(r.warnings)}`);
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: the multi-line list form is read, like touches", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore:\n  - "docs"    # prose, nothing to check\n  - holding\n'),
    trees: { "app/src": "index.ts", docs: "sample.ts", holding: "scratch.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, [],
    `both list entries must be honoured, quoted or not: ${JSON.stringify(r.problems)}`);
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: an entry is ignored at every depth, exactly as a ROOT_IGNORE entry is", () => {
  const { repo, flowDir } = repoFixture({
    config: cfgIgnore('source_roots_ignore: ["docs"]\n'),
    trees: { "app/src": "index.ts", docs: "sample.ts", "wrapper/docs": "sample.ts" },
  });
  const r = runDoctor({ flowDir });
  assert.deepEqual(r.problems, [],
    `"wrapper/" holds source only under an ignored name, so it is not a source tree: ${JSON.stringify(r.problems)}`);
  rmSync(repo, { recursive: true, force: true });
});

test("source_roots_ignore: an empty list, and no key at all, both warn about nothing", () => {
  for (const config of [cfgIgnore("source_roots_ignore: []\n"), cfg([{ path: "app/", check: "npm run lint" }])]) {
    const { repo, flowDir } = repoFixture({ config, trees: { "app/src": "index.ts" } });
    const r = runDoctor({ flowDir });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings.filter((w) => w.includes("source_roots_ignore")), [],
      `an unused escape hatch must be silent: ${JSON.stringify(r.warnings)}`);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parseSourceRootsIgnore: both list forms, comments stripped, and an absent file is no entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-ign-"));
  const at = (body) => { const p = join(dir, "config.yml"); writeFileSync(p, body); return p; };
  assert.deepEqual(parseSourceRootsIgnore(join(dir, "nope.yml")), []);
  assert.deepEqual(parseSourceRootsIgnore(at("source_roots:\n  - path: \"app/\"\n")), [],
    "`source_roots:` must not be mistaken for `source_roots_ignore:`");
  assert.deepEqual(parseSourceRootsIgnore(at('source_roots_ignore: ["docs", holding]   # two\n')), ["docs", "holding"]);
  assert.deepEqual(parseSourceRootsIgnore(at("source_roots_ignore: []\n")), []);
  assert.deepEqual(parseSourceRootsIgnore(at('source_roots_ignore:\n  # a comment\n  - "docs"\n  - holding\ncoverage_min: 80\n')),
    ["docs", "holding"]);
  rmSync(dir, { recursive: true, force: true });
});

// ── version drift (Flow infra is authored in canonical; repos adopt — the guard) ──

test("compareVersions: orders, tolerates v-prefix and short forms", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("v2", "v1.5"), 1);
});

test("version drift: no canonical version supplied → check is inert (no version warning)", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "0.1.0\n");
  const r = runDoctor({ flowDir: d });               // canonicalVersion undefined
  assert.deepEqual(r.problems, []);
  assert.ok(!r.warnings.some((w) => w.includes("behind canonical") || w.includes("VERSION stamp")));
  cleanup(d);
});

test("version drift: repo behind canonical → warning, not a problem", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "0.1.0\n");
  const r = runDoctor({ flowDir: d, canonicalVersion: "0.2.0" });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("behind canonical") && w.includes("0.1.0") && w.includes("0.2.0")));
  cleanup(d);
});

test("version drift: repo level with canonical → no warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  writeFileSync(join(d, "VERSION"), "1.0.0\n");
  const r = runDoctor({ flowDir: d, canonicalVersion: "1.0.0" });
  assert.ok(!r.warnings.some((w) => w.includes("behind canonical")));
  cleanup(d);
});

test("version drift: canonical known but no .flow/VERSION stamp → adoption warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });   // no VERSION file written
  const r = runDoctor({ flowDir: d, canonicalVersion: "0.2.0" });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("no .flow/VERSION stamp")));
  cleanup(d);
});

// ── uncommitted-task guard (CAN-41) ──

test("findUncommittedTasks: untracked task file is offending", () => {
  const porcelain = "?? .flow/tasks/0099-x.md\n M src/app.ts\n";
  assert.deepEqual(findUncommittedTasks(porcelain), [".flow/tasks/0099-x.md"]);
});

test("findUncommittedTasks: staged-but-uncommitted change to a tracked task is offending", () => {
  assert.deepEqual(findUncommittedTasks("M  .flow/tasks/0030-slim.md\n"), [".flow/tasks/0030-slim.md"]);
});

test("findUncommittedTasks: unstaged worktree change to a tracked task is offending", () => {
  assert.deepEqual(findUncommittedTasks(" M .flow/tasks/0030-slim.md\n"), [".flow/tasks/0030-slim.md"]);
});

test("findUncommittedTasks: _TEMPLATE.md and non-task changes are ignored", () => {
  const porcelain = " M .flow/tasks/_TEMPLATE.md\n M src/app.ts\n?? README.md\n";
  assert.deepEqual(findUncommittedTasks(porcelain), []);
});

test("findUncommittedTasks: a staged deletion (not on disk) is filtered out by `files`", () => {
  // The task was committed-then-deleted: porcelain reports it, but it's not in the on-disk set.
  assert.deepEqual(findUncommittedTasks("D  .flow/tasks/0001-gone.md\n", [".flow/tasks/0002-here.md"]), []);
});

test("runDoctor: an uncommitted task file (injected git status) is a PROBLEM", () => {
  const d = fixture({ "0099-x.md": task("P-0099") });
  const gitStatus = () => ({ inRepo: true, porcelain: "?? .flow/tasks/0099-x.md\n" });
  const r = runDoctor({ flowDir: d, gitStatus });
  assert.ok(r.problems.some((p) => p.includes("0099-x.md") && p.includes("not committed")));
  cleanup(d);
});

test("runDoctor: clean git status → no uncommitted-task problem, no skip note", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: true, porcelain: "" }) });
  assert.deepEqual(r.problems, []);
  assert.ok(!r.notes.some((n) => n.includes("uncommitted-task check skipped")));
  cleanup(d);
});

test("runDoctor: outside a git work tree → uncommitted-task check is skipped (a note, not a failure)", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: false, porcelain: "" }) });
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.some((n) => n.includes("uncommitted-task check skipped")));
  cleanup(d);
});

// ── readiness bar: the body shape a `ready` task must have (flow-0010) ──
// The bar `task-writer` is supposed to enforce, re-applied where it can't be skipped. Every
// test here is the "skipped task-writer" shape: legal frontmatter, unspecified body.

const NO_CRITERIA = `
## Context

Why.

## Scope

What.
`;

test("ready task with no ## Acceptance criteria section → PROBLEM naming the task and the section", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { body: NO_CRITERIA }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("## Acceptance criteria")),
    `expected a missing-criteria PROBLEM, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("ready task whose Acceptance criteria section has no `- [ ]` items → PROBLEM", () => {
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

It should work well and feel fast.
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes('no "- [ ]" items')));
  cleanup(d);
});

test("ready task whose only criteria are _TEMPLATE.md's placeholders → PROBLEM", () => {
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

- [ ] Given <situation>, when <action>, then <observable outcome>.
- [ ] …
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("placeholders")),
    `an uncustomised template is not a specified task, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("ready task missing ## Context or ## Scope → PROBLEM naming which section is absent", () => {
  const noScope = `
## Context

Why.

## Acceptance criteria

- [ ] Given a store, when the doctor runs, then it reports drift.
`;
  const noContext = `
## Scope

What.

## Acceptance criteria

- [ ] Given a store, when the doctor runs, then it reports drift.
`;
  const d = fixture({
    "0001-a.md": task("P-0001", { body: noScope }),
    "0002-b.md": task("P-0002", { body: noContext }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes('"## Scope"')));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes('"## Context"')));
  assert.ok(!r.problems.some((p) => p.includes("P-0001") && p.includes('"## Context"')),
    "the finding must name the section that is actually absent");
  cleanup(d);
});

test("ready task with all sections and one real criterion → no new problem or warning", () => {
  const d = fixture({ "0001-a.md": task("P-0001") });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("a criterion that merely quotes an <angle-bracket> token is real, not a placeholder", () => {
  // This task's own criteria quote `### G<n> — ` — "contains a <slot>" must not read as unedited.
  const body = `
## Context

Why.

## Scope

What.

## Acceptance criteria

- [ ] Given a heading \`### G<n> — <title>\`, when the extractor runs, then the id is returned.
`;
  const d = fixture({ "0001-a.md": task("P-0001", { body }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  cleanup(d);
});

test("body absent entirely (frontmatter only) on a ready task → PROBLEM, not a throw", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { body: "" }) });
  const r = runDoctor({ flowDir: d });                       // must not throw
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("empty body")),
    `expected an empty-body PROBLEM, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("body-shape checks do NOT fire for in_progress / in_review / done / blocked tasks", () => {
  // The bar applies where a task is offered to a worker. flow-doctor fails store-wide, so a
  // retroactive rule would redden every open PR in the repo, including PRs that can't fix it.
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-08-18", body: "" }),
    "0002-b.md": task("P-0002", { status: "in_review", branch: "flow/P-0002-x", pr: "http://pr/2", body: "" }),
    "0003-c.md": task("P-0003", { status: "done", body: "" }),
    "0004-d.md": task("P-0004", { status: "blocked", blocked_reason: "needs a decision", body: "" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "no body-shape problem may fire outside `ready`");
  assert.ok(!r.warnings.some((w) => w.includes("Acceptance criteria") || w.includes("empty body")));
  cleanup(d);
});

test("readinessFindings: pure, and returns one finding per absent section", () => {
  assert.deepEqual(readinessFindings({ id: "P-1", body: READY_BODY }), []);
  const bare = readinessFindings({ id: "P-1", body: "" });
  assert.equal(bare.length, 1);
  assert.ok(bare[0].includes("empty body"));
  assert.equal(readinessFindings({ id: "P-1", body: "## Notes\n\nnothing\n" }).length, 3);
});

// ── new-subsystem tell (a task that stands up a tree the repo doesn't have) ──

test("touches rooted at a top-level dir that doesn't exist → WARNING, never a problem", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { touches: '["mobile/**", "mobile/app/index.tsx"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const hits = r.warnings.filter((w) => w.includes("mobile/") && w.includes("subsystem"));
  assert.equal(hits.length, 1, "one warning per missing root, not one per glob");
  cleanup(d);
});

test("new-subsystem tell exempts ROOT_IGNORE dirs and globs with no directory component", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { touches: '[".github/workflows/flow-gates.yml", "CLAUDE.md", ".flow/bin/x.mjs"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(!r.warnings.some((w) => w.includes("subsystem")),
    `Flow's own plumbing and root files are not new subsystems, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

// ── vision-serves: a ready task must name the goal it advances (flow-0010) ──

test("no VISION.md → exactly one warning, no per-task serves finding, and exit-0 shape", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { serves: "[]" }),
    "0002-b.md": task("P-0002", { serves: '["G404"]' }),
  }, { vision: null });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "an adopting repo without a vision stays green");
  const vision = r.warnings.filter((w) => w.includes("VISION.md"));
  assert.equal(vision.length, 1, `expected one vision-inactive warning, got ${JSON.stringify(r.warnings)}`);
  assert.ok(vision[0].includes("inactive"));
  assert.ok(!r.warnings.some((w) => w.includes("serves")  && w.includes("P-0002")));
  cleanup(d);
});

test("VISION.md present + ready task with missing or empty serves → PROBLEM naming the task", () => {
  const noField = task("P-0002").replace(/^serves:.*$/m, "");
  const d = fixture({ "0001-a.md": task("P-0001", { serves: "[]" }), "0002-b.md": noField });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("no serves")));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes("no serves")));
  cleanup(d);
});

test("serves naming an unknown id, or a non-goal, is a PROBLEM in each case", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { serves: '["G404"]' }),
    "0002-b.md": task("P-0002", { serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes("P-0001") && p.includes("does not declare")));
  assert.ok(r.problems.some((p) => p.includes("P-0002") && p.includes("NON-GOAL")),
    "a task advancing a declared non-goal is drift with a paper trail");
  cleanup(d);
});

test("serves naming a retired goal → WARNING, not a problem", () => {
  // `status` is explicit rather than leaning on the fixture default. The retired-goal warning is
  // now status-dependent (see below), so a test that let the default supply the status would
  // silently change meaning the day that default moved — the failure mode where a test keeps
  // passing while no longer proving what its name claims.
  const d = fixture({ "0001-a.md": task("P-0001", { status: "ready", serves: '["G9"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")));
  cleanup(d);
});

test("a DONE task serving a retired goal is silent — the warning has no remedy it could take", () => {
  // Finished work cannot be dropped, and `serves` records the goal the task was WRITTEN to
  // advance, so it cannot honestly be re-anchored either. Warning about it asks the reader to
  // falsify history, and at volume it buries the live tasks that can still act on the advice.
  const d = fixture({ "0001-a.md": task("P-0001", { status: "done", serves: '["G9"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(!r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")),
    "a done task serving a retired goal should not warn");
  cleanup(d);
});

test("every non-done status still warns on a retired goal", () => {
  // The exemption is `done` and only `done`. Each of these is still live, and at least one of the
  // two remedies — dropping the task — remains a real call for the reader, so the line earns its
  // place. Table-driven so adding a status to the lifecycle surfaces here rather than silently
  // inheriting the exemption.
  for (const status of ["ready", "in_progress", "in_review", "blocked"]) {
    const d = fixture({
      "0001-a.md": task("P-0001", {
        status,
        serves: '["G9"]',
        // in_progress/in_review are only well-formed with a claim on them; without these the
        // store would fail for an unrelated reason and mask what this test is asking.
        owner: status === "ready" || status === "blocked" ? "" : "session_x",
        started: status === "ready" || status === "blocked" ? "" : "2026-09-14T02:10:04Z",
        blocked_reason: status === "blocked" ? "waiting on something" : "",
      }),
    });
    const r = runDoctor({ flowDir: d });
    assert.ok(r.warnings.some((w) => w.includes("P-0001") && w.includes("Retired")),
      `status "${status}" should still warn on a retired goal`);
    cleanup(d);
  }
});

test("the done exemption does not leak to the sibling serves branches", () => {
  // An aged anchor is forgivable; a broken or self-contradicting one is not. An id VISION.md never
  // declared, or one it declares a NON-GOAL, still reports on finished work — those say the record
  // is wrong, not merely old. (On a non-ready task they report as warnings, which is the existing
  // severity rule and deliberately left alone.)
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "done", serves: '["G404"]' }),
    "0002-b.md": task("P-0002", { status: "done", serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  const all = [...r.problems, ...r.warnings];
  assert.ok(all.some((m) => m.includes("P-0001") && m.includes("does not declare")),
    "a done task naming an undeclared goal id must still report");
  assert.ok(all.some((m) => m.includes("P-0002") && m.includes("NON-GOAL")),
    "a done task naming a declared non-goal must still report");
  cleanup(d);
});

test('serves: ["maintenance"] reports nothing and looks nothing up', () => {
  // The fixture VISION.md declares no goal called "maintenance" — so a silent run is the proof
  // that the reserved id short-circuits before the lookup, not that the lookup happened to hit.
  const d = fixture({ "0001-a.md": task("P-0001", { serves: '["maintenance"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("non-ready tasks: empty serves is silent, and a bad id warns instead of failing", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "done", serves: "[]" }),
    "0002-b.md": task("P-0002", { status: "in_progress", owner: "s", started: "2026-08-18", serves: '["G404"]' }),
    "0003-c.md": task("P-0003", { status: "blocked", blocked_reason: "waiting", serves: '["NG1"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "adopting the check must not retroactively fail history");
  assert.ok(!r.warnings.some((w) => w.includes("P-0001") && w.includes("serves")));
  assert.ok(r.warnings.some((w) => w.includes("P-0002") && w.includes("does not declare")));
  assert.ok(r.warnings.some((w) => w.includes("P-0003") && w.includes("NON-GOAL")));
  cleanup(d);
});

test("a VISION.md with zero extractable goals → repo-level PROBLEM naming the heading format", () => {
  const d = fixture({ "0001-a.md": task("P-0001") }, { vision: "# Vision\n\n## Goals\n\n* Be good\n* Be fast\n" });
  const r = runDoctor({ flowDir: d });
  const fmt = r.problems.filter((p) => p.includes("VISION.md declares no goals"));
  assert.equal(fmt.length, 1, `expected the format problem, got ${JSON.stringify(r.problems)}`);
  assert.ok(fmt[0].includes("### G<n>"));
  assert.ok(!r.problems.some((p) => p.includes("P-0001")),
    "with no goals extractable, per-task serves checks would be vacuous — report the format once instead");
  cleanup(d);
});

test("goal headings: hyphen and en-dash separators still extract; a malformed one warns by name", () => {
  const vision = `# Vision

## Goals

### G1 — Em dash
### G2 - Hyphen
### G3 – En dash
### G4 No separator at all
`;
  const d = fixture({ "0001-a.md": task("P-0001", { serves: '["G2", "G3"]' }) }, { vision });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "G2 and G3 must resolve — a mistyped dash can't drop a goal");
  assert.ok(r.warnings.some((w) => w.includes("G4 No separator at all") && w.includes("### G<n>")),
    `one mistyped heading must not vanish silently, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("parseVisionGoals: ids, kinds, retirement — by line regex, never a Markdown parser", () => {
  const { goals, malformed } = parseVisionGoals(VISION);
  assert.deepEqual([...goals.keys()], ["G1", "G2", "NG1", "G9"]);
  assert.equal(goals.get("G1").kind, "goal");
  assert.equal(goals.get("G1").title, "Ship the thing");
  assert.equal(goals.get("NG1").kind, "non-goal");
  assert.equal(goals.get("G9").retired, true);
  assert.equal(goals.get("G1").retired, false);
  assert.deepEqual(malformed, []);
});

// ── the CLI contract: PROBLEM exits 1, WARNING exits 0 ──
// Run the real CLI over a fixture store, because the exit code is the half of the bar CI
// actually reads — `runDoctor` returning findings proves nothing if the process exits 0.

function cliFixture(files, opts) {
  const flowDir = fixture(files, opts);
  mkdirSync(join(flowDir, "bin"), { recursive: true });
  // Every module flow-doctor imports, not just the entry point: a missing one is an
  // ERR_MODULE_NOT_FOUND on stderr with exit 1, which an exit-code assertion reads as "the
  // problem was found". Add to this list whenever flow-doctor gains a relative import.
  for (const f of ["flow-doctor.mjs", "apply-board-edits.mjs", "asks.mjs"])
    copyFileSync(join(import.meta.dirname, f), join(flowDir, "bin", f));
  return flowDir;
}
function runCli(flowDir) {
  // spawnSync, not execFileSync: warnings are written to stderr and the run still exits 0,
  // so a stdout-only reader would see an empty page and call the check silent.
  const r = spawnSync("node", [join(flowDir, "bin", "flow-doctor.mjs")], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("CLI: an unready ready-task exits 1 and names the task", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { body: "" }) });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*P-0001/);
  cleanup(d);
});

test("CLI: warnings alone (new subsystem, no vision) still exit 0", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { touches: '["mobile/**"]', serves: "[]" }) }, { vision: null });
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.match(out, /WARN.*subsystem/);
  cleanup(d);
});

// ── blocked_by: the machine-readable half of blocked_reason (flow-0040) ──
// The line the whole check is drawn on: the ONLY finding a store written before this field can
// trip is a warning. Every PROBLEM below needs a populated `blocked_by` to fire, and a task
// that predates the field has none — so adoption cannot turn an already-adopted repo red.

// `yaml` is a real YAML parser, and this is the one assertion that wants one — but NOTHING else
// under `project-template/.flow/bin/` imports a non-`node:` module, deliberately: this tree is
// copied into repos that may not be JavaScript projects at all, and canonical's own config.yml
// names the rule ("every dependency added here is a dependency imposed downstream"). So the
// parser is loaded OPTIONALLY. Canonical has it, so the strict parse runs on every gate run here
// — which is where `_TEMPLATE.md` is authored and where a break would be introduced. A consuming
// repo without it still gets the flow-doctor-parser half below, which is the reader that
// actually matters there.
const yamlParse = await import("yaml").then((m) => m.parse, () => null);

test("_TEMPLATE.md ships blocked_by as an empty list, and still parses", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "tasks", "_TEMPLATE.md"), "utf8");

  if (yamlParse) {
    const parsed = yamlParse(text.slice(3, text.indexOf("\n---", 3)));
    assert.ok(Object.hasOwn(parsed, "blocked_by"), "the published template must declare the field");
    assert.deepEqual(parsed.blocked_by, [], "it ships empty — absent means 'not declared'");
    assert.equal(parsed.status, "ready", "the rest of the frontmatter must survive the addition");
  }

  // The other reader, and the one every consuming repo runs: flow-doctor's own frontmatter scan.
  // Proving both agree beats trusting that a YAML-valid file is also parseListField-valid.
  const d = fixture({ "0001-a.md": text.replace('id: "PROJ-0000"', 'id: "P-0001"') });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems.filter((x) => x.includes("blocked_by")), [],
    `the shipped template must be clean under the check it ships with, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("blocked with a blocked_by naming a task id → reported as nothing at all", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on P-0002", blocked_by: '["P-0002"]' }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("blocked_by")), [],
    `a fully declared block is the good case, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("blocked with a blocked_by naming a PR url → also clean", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on #51",
      blocked_by: '["https://github.com/o/r/pull/51"]' }),
  });
  assert.deepEqual(runDoctor({ flowDir: d }).problems, []);
  cleanup(d);
});

test("blocked with an EMPTY blocked_by → WARNING that names the way out", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting on something", blocked_by: "[]" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "criterion 6: a repo full of pre-field blocked tasks must not go red");
  const w = r.warnings.filter((x) => x.includes("P-0001") && x.includes("blocked_by"));
  assert.equal(w.length, 1, `expected one nudge, got ${JSON.stringify(r.warnings)}`);
  assert.match(w[0], /task id or PR url/, "the message has to say how to make the block machine-checkable");
  assert.match(w[0], /not machine-checkable/, "…and name the opt-out for a block that genuinely isn't");
  cleanup(d);
});

test('blocked_reason saying "not machine-checkable" silences the nudge', () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_by: "[]",
      blocked_reason: "Waiting on the client's lawyer to call back - not machine-checkable." }),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("blocked_by")), [],
    "a declared-unmechanical block is answered, not nagged");
  cleanup(d);
});

test("ready with a populated blocked_by → PROBLEM: a dependency that outlived its block", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "ready", blocked_by: '["P-0002"]' }) });
  const r = runDoctor({ flowDir: d });
  const p = r.problems.filter((x) => x.includes("P-0001") && x.includes("blocked_by"));
  assert.equal(p.length, 1, `expected the stale-dependency problem, got ${JSON.stringify(r.problems)}`);
  assert.match(p[0], /stale data/);
  assert.match(p[0], /P-0002/, "name the dependency, so the reader knows what to delete");
  cleanup(d);
});

test("in_progress and in_review are live too — a leftover blocked_by is stale there as well", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "in_progress", owner: "s", started: "2026-09-01T10:00:00Z",
      blocked_by: '["P-0009"]' }),
    "0002-b.md": task("P-0002", { status: "in_review", branch: "flow/x", pr: "https://github.com/o/r/pull/2",
      touches: '["api/**"]', blocked_by: '["P-0009"]' }),
  }, { dirs: ["src", "api"] });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((x) => x.includes("P-0001") && x.includes("stale data")));
  assert.ok(r.problems.some((x) => x.includes("P-0002") && x.includes("stale data")));
  cleanup(d);
});

test("done keeps its blocked_by — there it is history, not drift", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { status: "done", blocked_by: '["P-0002"]' }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "clearing a done task's record of what it waited on destroys the record");
  cleanup(d);
});

test("a malformed blocked_by entry → PROBLEM naming the entry", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { status: "blocked", blocked_reason: "waiting",
      blocked_by: '["P-0002", "the PR Dan opened last week"]' }),
  });
  const r = runDoctor({ flowDir: d });
  const p = r.problems.filter((x) => x.includes("malformed"));
  assert.equal(p.length, 1, `only the bad entry is malformed, got ${JSON.stringify(r.problems)}`);
  assert.match(p[0], /the PR Dan opened last week/);
  assert.match(p[0], /task id .* or a PR url/);
  cleanup(d);
});

test("blocked_by in the multi-line list form is read, not silently seen as empty", () => {
  // parseListField's older sibling bug: a naive same-line scan reads the block form as empty,
  // which would silence the stale-dependency PROBLEM entirely.
  const body = `---
id: "P-0001"
title: "x"
status: "ready"
priority: 3
blocked_reason: ""
blocked_by:
  - "P-0002"
  - "https://github.com/o/r/pull/7"
serves: ["G1"]
touches: ["src/**"]
---
${READY_BODY}`;
  const d = fixture({ "0001-a.md": body });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((x) => x.includes("P-0002") && x.includes("stale data")),
    `the block form must parse, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("isBlockedByEntry: the shape contract, stated once", () => {
  for (const ok of ["P-0002", "flow-0040", "write_2-17", "https://github.com/o/r/pull/51", " P-0002 "])
    assert.equal(isBlockedByEntry(ok), true, ok);
  for (const bad of ["", "P-", "0002", "-0002", "P 0002", "github.com/o/r/pull/51", "ftp://x/y", "P-0002 and P-0003"])
    assert.equal(isBlockedByEntry(bad), false, JSON.stringify(bad));
  assert.equal(isBlockedByEntry(undefined), false);
});

test("blockedByFindings: an absent blocked_by is 'not declared', never an error", () => {
  // Criterion 6 at unit level: the pre-field shape of every task in every adopted repo.
  for (const status of ["ready", "in_progress", "in_review", "done", "blocked"]) {
    const f = blockedByFindings({ id: "P-1", status, blocked_reason: "r" });
    assert.deepEqual(f.problems, [], status);
    if (status !== "blocked") assert.deepEqual(f.warnings, [], status);
  }
});

test("a store that predates blocked_by entirely gets the same verdict as before — CLI exit 0", () => {
  const d = cliFixture({
    "0001-a.md": task("P-0001"),
    "0002-b.md": task("P-0002", { status: "blocked", blocked_reason: "waiting on a decision", touches: '["api/**"]' }),
    "0003-c.md": task("P-0003", { status: "done", touches: '["docs/**"]' }),
  }, { dirs: ["src", "api", "docs"] });
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /FAIL/, "adopting the field must not fail a repo that has never used it");
  assert.match(out, /WARN.*P-0002.*blocked_by/, "it may nudge — a nudge is exit 0");
  cleanup(d);
});

test("CLI: a stale blocked_by exits 1 — the PROBLEM half is really a PROBLEM", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { blocked_by: '["P-0002"]' }) });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*P-0001/);
  cleanup(d);
});

// ── the intent store (flow-0063) ──
// G11 — "work traces to a stated intent" — gets a store, a template and a checker with no teeth
// beyond shape. Every assertion below is about SHAPE; not one reads a word of an intent's prose,
// which is the teeth budget from ADR-0004 being spent deliberately rather than forgotten.

test("no .flow/intents/ at all → exactly one warning naming the store, and no problem", () => {
  // Criterion 1. The adoption posture: every repo on earth is in this state today, and adopting
  // the layer must not turn any of them red.
  const d = fixture({ "0001-a.md": task("P-0001") }, { intents: null });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const store = r.warnings.filter((w) => w.includes(".flow/intents/"));
  assert.equal(store.length, 1, `exactly one, got ${JSON.stringify(r.warnings)}`);
  assert.match(store[0], /intent layer is inactive/);
  cleanup(d);
});

test("CLI: a repo with no intent store still exits 0", () => {
  // Criterion 1, exit-code half — a warning that failed the gate would be a PROBLEM in disguise.
  const d = cliFixture({ "0001-a.md": task("P-0001") }, { intents: null });
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.match(out, /WARN.*\.flow\/intents\//);
  assert.doesNotMatch(out, /FAIL/);
  cleanup(d);
});

test("an intent whose frontmatter does not parse → PROBLEM naming its path", () => {
  // Criterion 2.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: {
      "no-frontmatter.md": "just prose, no frontmatter at all\n",
      "unterminated.md": '---\nid: "x"\ntitle: "y"\n',
    },
  });
  const r = runDoctor({ flowDir: d });
  for (const f of [".flow/intents/no-frontmatter.md", ".flow/intents/unterminated.md"])
    assert.ok(r.problems.some((p) => p.includes(f) && p.includes("malformed frontmatter")),
      `${f} must be named, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("CLI: a malformed intent exits 1 — the PROBLEM half is really a PROBLEM", () => {
  // Criterion 2, exit-code half.
  const d = cliFixture({ "0001-a.md": task("P-0001") }, { intents: { "broken.md": "no frontmatter\n" } });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*\.flow\/intents\/broken\.md/);
  cleanup(d);
});

test("an intent missing a required field → PROBLEM naming the file AND the field", () => {
  // Criterion 3, once per required field, so a field silently dropped from INTENT_REQUIRED
  // cannot pass unnoticed.
  for (const field of INTENT_REQUIRED) {
    const d = fixture({ "0001-a.md": task("P-0001") }, {
      intents: { "thin.md": intent("thin", { omit: [field] }) },
    });
    const r = runDoctor({ flowDir: d });
    assert.ok(
      r.problems.some((p) => p.includes(".flow/intents/thin.md") && p.includes(field)),
      `missing "${field}" must name both file and field, got ${JSON.stringify(r.problems)}`,
    );
    cleanup(d);
  }
});

test("a declared-but-empty required field counts as missing, same as a task's", () => {
  // Criterion 3, the near-miss: `title: ""` is the shape the template ships and it is not a
  // filled-in intent. Task validation already reads empty as missing; the two stores agree.
  const d = fixture({ "0001-a.md": task("P-0001") }, { intents: { "blank.md": intent("blank", { title: "" }) } });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes(".flow/intents/blank.md") && p.includes("title")),
    JSON.stringify(r.problems));
  cleanup(d);
});

test("two intents declaring the same id → PROBLEM naming the id and both paths", () => {
  // Criterion 4.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: { "a-first.md": intent("same-slug"), "b-second.md": intent("same-slug") },
  });
  const r = runDoctor({ flowDir: d });
  const dup = r.problems.filter((p) => p.includes("duplicate intent id"));
  assert.equal(dup.length, 1, JSON.stringify(r.problems));
  assert.match(dup[0], /same-slug/);
  assert.match(dup[0], /\.flow\/intents\/a-first\.md/);
  assert.match(dup[0], /\.flow\/intents\/b-second\.md/);
  cleanup(d);
});

test("approved_by and approved_at both empty → not a problem, not even a warning", () => {
  // Criterion 5. This is the state of EVERY intent while its PR is open, which is the only
  // moment anyone looks at one. CI writes these from the merge (ADR-0007, slice 4); a checker
  // that demanded them here would fail the layer's entire happy path.
  const d = fixture({ "0001-a.md": task("P-0001") }, { intents: { "waiting.md": intent("waiting") } });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => /approved_(by|at)/.test(w)), [],
    `the approval record is unvalidated in this slice, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

// flow-sync delivers `.flow/bin/` but NOT `.flow/intents/`, so in an adopting repo the published
// intent template is normally absent. The tests below that read the template's own bytes skip
// there instead of failing: they are checks on the artefact canonical publishes, and canonical
// (plus any repo that copied the template in) still runs them. 2.1.1: five of these failed
// every synced repo's flow-tooling job.
const INTENT_TEMPLATE_PATH = join(import.meta.dirname, "..", "intents", "_TEMPLATE.md");
const NO_INTENT_TEMPLATE = existsSync(INTENT_TEMPLATE_PATH)
  ? false
  : "no .flow/intents/_TEMPLATE.md in this repo (flow-sync does not deliver it)";

test("an intent store holding only _TEMPLATE.md is clean — the template is excluded", { skip: NO_INTENT_TEMPLATE }, () => {
  // Criterion 6. The template ships empty required fields on purpose; validating it would fail
  // every repo that adopted the layer and had not yet written an intent.
  const tpl = readFileSync(join(import.meta.dirname, "..", "intents", "_TEMPLATE.md"), "utf8");
  const d = fixture({ "0001-a.md": task("P-0001") }, { intents: { "_TEMPLATE.md": tpl } });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("intents")), [],
    `a store holding only the template is a healthy empty store, got ${JSON.stringify(r.warnings)}`);
  assert.equal(intentFindings(join(d, "intents")).count, 0, "the template is not an intent");
  cleanup(d);
});

test("the shipped intent _TEMPLATE.md declares every field the validator requires", { skip: NO_INTENT_TEMPLATE }, () => {
  // Criteria 7 and 9. The template cannot describe a shape its own checker rejects, and it ships
  // `evidence` as an empty list. Asserted through BOTH readers: a real YAML parser where one is
  // available, and flow-doctor's own dependency-free scan, which is the one every consuming repo
  // actually runs.
  const text = readFileSync(join(import.meta.dirname, "..", "intents", "_TEMPLATE.md"), "utf8");
  const head = text.slice(3, text.indexOf("\n---", 3));

  if (yamlParse) {
    const parsed = yamlParse(head);
    for (const k of [...INTENT_REQUIRED, "approved_by", "approved_at", "evidence"])
      assert.ok(Object.hasOwn(parsed, k), `the published template must declare "${k}"`);
    assert.deepEqual(parsed.evidence, [], "evidence ships as an empty list — it is append-only");
  }

  // flow-doctor's reader: fill only the placeholders an author fills, and the file validates
  // clean. Anything the checker requires but the template omits shows up here as a PROBLEM.
  const filled = head
    .replace(/^id: ""/m, 'id: "some-slug"')
    .replace(/^title: ""/m, 'title: "Something a human asked for"')
    .replace(/^created: ""/m, 'created: "2026-09-24"')
    .replace(/^source: ""/m, 'source: "Dan, interviewed 2026-09-24"');
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: { "some-slug.md": `---${filled}\n---\n\n## Problem\n\nx\n\n## Outcome\n\ny\n` },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [],
    `the shipped template must be clean under the check it ships with, got ${JSON.stringify(r.problems)}`);
  assert.deepEqual(r.warnings.filter((w) => w.includes("intents")), [], JSON.stringify(r.warnings));
  assert.equal(evidenceShape(head), "list", "`evidence: []` must read as a list, not as a scalar");
  cleanup(d);
});

test("evidence absent, or an empty list, is reported as nothing at all", () => {
  // Criterion 10. Absent is the pre-field shape of every intent ever written; empty is the
  // template's. Both mean the same thing — no evidence gathered yet — so neither is a finding.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: {
      "none.md": intent("none", { evidence: null }),        // key omitted entirely
      "empty-inline.md": intent("empty-inline", { evidence: "[]" }),
      "empty-block.md": intent("empty-block", { evidence: "" }),   // `evidence:` with nothing under it
    },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("evidence")), [], JSON.stringify(r.warnings));
  cleanup(d);
});

test("evidence that is not a list of strings → WARNING naming the file, never a PROBLEM", () => {
  // Criterion 11. The no-teeth budget holds for `evidence` too: nothing consumes the value in
  // this slice, so a malformed one must not redden a whole repo's gate.
  const cases = {
    "scalar.md": '"docs/evidence/one.md"',
    "number-list.md": "[1, 2]",
    "mapping-list.md": "\n  - path: docs/evidence/one.md",
    "nested-list.md": "\n  - [docs/evidence/one.md]",
  };
  for (const [name, evidence] of Object.entries(cases)) {
    const d = fixture({ "0001-a.md": task("P-0001") }, {
      intents: { [name]: intent(name.replace(/\.md$/, ""), { evidence }) },
    });
    const r = runDoctor({ flowDir: d });
    assert.deepEqual(r.problems, [], `${name}: must not be a problem — got ${JSON.stringify(r.problems)}`);
    assert.ok(r.warnings.some((w) => w.includes(`.flow/intents/${name}`) && w.includes("evidence")),
      `${name}: expected a warning naming the file, got ${JSON.stringify(r.warnings)}`);
    cleanup(d);
  }
});

test("evidence holding real paths, inline or block, is read as a list and reported as nothing", () => {
  // The good case for criterion 11's counterpart: both YAML list forms must survive the
  // dependency-free reader, or an intent that correctly records its evidence would warn forever.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: {
      "inline.md": intent("inline", { evidence: '["docs/evidence/a.md", "docs/evidence/b.md"]' }),
      "block.md": intent("block", { evidence: '\n  - "docs/evidence/a.md"\n  - docs/evidence/b.md' }),
    },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("evidence")), [], JSON.stringify(r.warnings));
  cleanup(d);
});

test("evidenceShape: the shape contract, stated once", () => {
  assert.equal(evidenceShape('id: "x"'), "absent");
  assert.equal(evidenceShape("evidence: []"), "list");
  assert.equal(evidenceShape("evidence:"), "list");
  assert.equal(evidenceShape('evidence: ["a/b.md"]'), "list");
  assert.equal(evidenceShape("evidence: []   # append-only"), "list");
  assert.equal(evidenceShape('evidence:\n  - "a/b.md"\n  - c/d.md\nstatus: "proposed"'), "list");
  assert.equal(evidenceShape('evidence: "a/b.md"'), "not-a-list");
  assert.equal(evidenceShape("evidence: 3"), "not-a-list");
  assert.equal(evidenceShape('evidence: ["a/b.md"'), "not-a-list");
  assert.equal(evidenceShape("evidence: [true]"), "not-a-list");
  assert.equal(evidenceShape("evidence:\n  - path: a/b.md"), "not-a-list");
  assert.equal(evidenceShape('evidence:\n  - ""'), "not-a-list");
});

// ── canonical-only assertions ──
// This test file travels into every adopting repo, where `../../..` is not a repo root and
// `docs/adr/` is not canonical's. The guard is exact rather than a bare existsSync: "the tree
// three levels up contains THIS directory at project-template/.flow/bin" is true in canonical
// and false everywhere else.
const canonicalRoot = resolve(import.meta.dirname, "..", "..", "..");
const inCanonical =
  resolve(canonicalRoot, "project-template", ".flow", "bin") === resolve(import.meta.dirname);

test("canonical's own .flow/intents/_TEMPLATE.md is byte-identical to the published one",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // Two copies of a template drift, and the one an author happens to open stops being the one
    // that is maintained. Canonical authors intents in its own store, so the two must not differ.
    const published = readFileSync(join(import.meta.dirname, "..", "intents", "_TEMPLATE.md"), "utf8");
    const own = readFileSync(join(canonicalRoot, ".flow", "intents", "_TEMPLATE.md"), "utf8");
    assert.equal(own, published, "canonical's copy has drifted from the published artefact");
  });

// The shipped config is the only place an adopter learns the key exists (flow-0102). A hatch
// nobody can find is the patched-flow-doctor.mjs they had before — and one shipped WITH an entry
// would silently exempt a tree in every fresh adoption, which is the failure the key exists to
// make visible. So: present, documented, and empty.
test("the published template config documents source_roots_ignore, empty, as a decision",
  { skip: inCanonical ? false : "not canonical" }, () => {
    const configPath = join(import.meta.dirname, "..", "config.yml");
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /^source_roots_ignore: \[\]/m, "the key must ship, uncommented and empty");
    assert.deepEqual(parseSourceRootsIgnore(configPath), [],
      "a shipped entry would exempt a tree in every repo that adopts Flow");
    // The DECLARATION, not the earlier prose mention of the key inside the source_roots comment.
    const comment = text.slice(0, text.indexOf("\nsource_roots_ignore:")).split(/\n\s*\n/).pop();
    assert.match(comment, /never gated/i, "the comment must say an ignored folder is never gated");
    assert.match(comment, /decision/i, "…and that ignoring one is therefore a decision, not a default");
  });

test("ADR-0007 records the grandfathering, teeth and triage decisions, each as a decision",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // Criterion 8. The three answers the task's notes flagged as rejectable must be findable as
    // decisions with reasons, not inferable from their absence.
    const adr = readFileSync(join(canonicalRoot, "docs", "adr", "0007-intent-layer.md"), "utf8");
    for (const heading of [
      "### Grandfathering: forward-only",
      "### Teeth: none in this slice",
      "### The triage collision: deferred, not overlooked",
    ]) assert.ok(adr.includes(heading), `ADR-0007 must state "${heading}" as its own decision`);
    assert.match(adr, /## Decision/);
  });

test("ADR-0007 records the evidence-linkage decision and the validation-contract deferral",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // Criterion 13.
    const adr = readFileSync(join(canonicalRoot, "docs", "adr", "0007-intent-layer.md"), "utf8");
    for (const heading of [
      "### Evidence lives in separate records, linked through `evidence`",
      "### The validation contract: deferred to a pilot in the Later repo",
    ]) assert.ok(adr.includes(heading), `ADR-0007 must state "${heading}" as its own decision`);
  });

test("the intent _TEMPLATE.md's Outcome guidance is about the person, not the artefact", { skip: NO_INTENT_TEMPLATE }, () => {
  // Criterion 12. An outcome written as a delivered artefact is what makes intents
  // solution-shaped, so the definition and its non-example are both load-bearing template text.
  const text = readFileSync(join(import.meta.dirname, "..", "intents", "_TEMPLATE.md"), "utf8");
  const outcome = text.slice(text.indexOf("\n## Outcome"));
  assert.ok(outcome.length > 0, "the template must have an Outcome section");
  assert.match(outcome, /observable change in the user's situation, behaviour, or operating environment/);
  assert.match(outcome, /not a delivered artefact/);
  assert.match(outcome, /"A dashboard exists" is not an outcome/);
  assert.doesNotMatch(text, /^## Success/m, "the section is Outcome, not Success");
});

// ── the intent template, part 2 (flow-0073) ──
// flow-0063 shipped the store, the template and a shape-only checker. This slice adds the four
// things the interview skill needs to write into — `serves`, `supersedes`, the stated `status`
// vocabulary and the `[assumption]` marker — plus the three sections that hold the interview's
// answers. Every new CHECK below is a warning, because the intent layer still has no teeth
// (ADR-0007); what is proved here is that each one FIRES and that none of them fails the gate.

// The published intent template, and — in canonical only — the copy canonical authors its own
// intents from. Read once: several assertions below are about the same bytes.
const INTENT_TEMPLATE = NO_INTENT_TEMPLATE ? "" : readFileSync(INTENT_TEMPLATE_PATH, "utf8");
const INTENT_TEMPLATE_HEAD = INTENT_TEMPLATE.slice(3, INTENT_TEMPLATE.indexOf("\n---", 3));
// The shipped worked example. An adopting repo is told it may delete it, so every assertion
// about it is skipped rather than failed when it is not there.
const EXAMPLE_PATH = join(import.meta.dirname, "..", "intents", "newsletter-send-cadence.md");
const haveExample = existsSync(EXAMPLE_PATH);

// A section of a Markdown file, from its `## Heading` to the next one.
function mdSection(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  if (start === -1) return "";
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test("criterion 1: both shipped intent templates declare `serves: []` and `supersedes: \"\"`, and are byte-identical", { skip: NO_INTENT_TEMPLATE }, () => {
  // Proved through both readers, for the same reason flow-0063 did it: the YAML parser says the
  // frontmatter is well-formed, and flow-doctor's dependency-free scan says the SHAPE is the one
  // the checker can actually see. A `serves` the checker reads as empty is a check gone quiet.
  if (yamlParse) {
    const parsed = yamlParse(INTENT_TEMPLATE_HEAD);
    assert.deepEqual(parsed.serves, [], "`serves` must ship as an empty list, not a plausible id");
    assert.equal(parsed.supersedes, "", "`supersedes` must ship as an empty string");
  }
  const servesLine = INTENT_TEMPLATE_HEAD.split("\n").find((l) => l.startsWith("serves:"));
  assert.ok(servesLine, "no `serves:` line at column 0 of the intent template's frontmatter");
  assert.equal(servesLine.replace(/^serves:\s*/, "").split("#")[0].trim(), "[]");
  const supersedesLine = INTENT_TEMPLATE_HEAD.split("\n").find((l) => l.startsWith("supersedes:"));
  assert.ok(supersedesLine, "no `supersedes:` line at column 0 of the intent template's frontmatter");
  assert.equal(supersedesLine.replace(/^supersedes:\s*/, "").split("#")[0].trim(), '""');

  // The byte-identity half. Canonical is the only checkout that HAS two copies; everywhere else
  // there is one file and nothing to compare. (The same pairing is asserted independently by
  // "canonical's own .flow/intents/_TEMPLATE.md is byte-identical to the published one" above —
  // stated twice on purpose, because this criterion is about the two fields AND the identity.)
  if (inCanonical) {
    const own = readFileSync(join(canonicalRoot, ".flow", "intents", "_TEMPLATE.md"), "utf8");
    assert.equal(own, INTENT_TEMPLATE, "canonical's intent template has drifted from the published one");
  }
});

test("criterion 2: the template documents the [assumption] marker, the three statuses, and the three new sections", { skip: NO_INTENT_TEMPLATE }, () => {
  assert.match(INTENT_TEMPLATE, /\[assumption\]/,
    "the template never names the marker, so a hand-written intent and a skill-written one will not look alike");
  assert.match(INTENT_TEMPLATE, /never reports these lines|flow-doctor never reports/i,
    "the template does not say the marker is never reported — an author who thinks it will nag stops marking");
  assert.match(INTENT_TEMPLATE, /except `## Problem`|Problem.{0,80}only the human's words/s,
    "the template does not state that Problem holds only the human's words and never an assumption");

  // The vocabulary, read out of the checker rather than retyped, so the guidance cannot describe
  // a set the code does not enforce.
  for (const v of INTENT_STATUSES)
    assert.ok(INTENT_TEMPLATE_HEAD.includes(v), `the template's status guidance omits "${v}"`);

  for (const heading of ["Cost of inaction", "Constraints", "Open questions"])
    assert.ok(mdSection(INTENT_TEMPLATE, heading), `the template has no "## ${heading}" section`);

  const open = mdSection(INTENT_TEMPLATE, "Open questions").replace(/\s+/g, " ");
  assert.match(open, /[Ss]urface them; never resolve them|never resolved/,
    "the Open questions guidance does not say questions are surfaced, never resolved");
  assert.match(open, /empty section/i,
    "the Open questions guidance does not say an empty section is a claim that nothing is uncertain");
});

test("criterion 3: the worked example is clean under flow-doctor, and carries an assumption and an open question",
  { skip: haveExample ? false : "the shipped example intent has been removed from this repo" }, () => {
    const text = readFileSync(EXAMPLE_PATH, "utf8");
    assert.ok(/^\s*(?:[-*]\s+)?\[assumption\]/m.test(text),
      "the worked example carries no `[assumption]` line — the marker is documented and never demonstrated");
    assert.ok(mdSection(text, "Open questions").split("\n").some((l) => /^\s*[-*]\s+\S/.test(l)),
      "the worked example's Open questions section holds no question");
    assert.match(text, /^status: "proposed"$/m, "the worked example must ship at the status every intent starts at");

    // Run the real doctor over the repo this file ships in — in canonical that is the template
    // repo, whose VISION.md declares the G1 the example serves. Filtered to the example's own
    // findings: the criterion is about this file, not about whatever else the host repo's store
    // happens to be carrying.
    const r = runDoctor({ flowDir: join(import.meta.dirname, "..") });
    const mine = (xs) => xs.filter((x) => x.includes("newsletter-send-cadence"));
    assert.deepEqual(mine(r.problems), [], `the shipped example must be a clean intent: ${JSON.stringify(r.problems)}`);
    assert.deepEqual(mine(r.warnings), [], `the shipped example must not warn either: ${JSON.stringify(r.warnings)}`);
  });

test("criterion 4: an intent whose `serves` names an undeclared id → WARNING naming file and id, exit still 0", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001") }, {
    intents: { "drifted.md": intent("drifted", { serves: '["G404"]' }) },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], `an intent is not a unit of work — this must never fail the gate: ${JSON.stringify(r.problems)}`);
  assert.ok(r.warnings.some((w) => w.includes(".flow/intents/drifted.md") && w.includes("G404")),
    `expected a warning naming the file and the id, got ${JSON.stringify(r.warnings)}`);
  // Exit 0 asserted through the CLI, not inferred from an empty problems array: the two can
  // disagree, and the process exit code is what a consuming repo's gate actually reads.
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.match(out, /WARN[\s\S]*G404/);
  cleanup(d);
});

test("criterion 4b: `maintenance`, and a declared id, both resolve silently on an intent", () => {
  // The reserved id is the same reserved id tasks use — one vocabulary, or an author has to know
  // which store they are writing into before they can name what the work is for.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: {
      "upkeep.md": intent("upkeep", { serves: '["maintenance"]' }),
      "real.md": intent("real", { serves: '["G1", "G2"]' }),
      "nonlist.md": intent("nonlist", { serves: '\n  - "G1"' }),   // the block form too
    },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("serves")), [],
    `a resolvable serves must be silent, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("criterion 5: no VISION.md → no per-intent `serves` warning, just the one vision-inactive line", () => {
  // Graceful adoption, and the same posture the task side takes. Repeating "the vision layer is
  // off" once per intent is how a one-line adoption nudge turns into a wall nobody reads.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    vision: null,
    intents: { "anchored.md": intent("anchored", { serves: '["G1", "G404"]' }) },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes(".flow/intents/") && w.includes("serves")), [],
    `no VISION.md means the serves check is inactive, got ${JSON.stringify(r.warnings)}`);
  assert.equal(r.warnings.filter((w) => /vision layer is inactive/.test(w)).length, 1,
    `exactly one vision-inactive warning, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("criterion 6: an intent whose `status` is outside the vocabulary → WARNING naming file and value", () => {
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: { "wrong-status.md": intent("wrong-status", { status: "done" }) },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], `the vocabulary has no teeth in this slice: ${JSON.stringify(r.problems)}`);
  assert.ok(r.warnings.some((w) => w.includes(".flow/intents/wrong-status.md") && w.includes("done")),
    `expected a warning naming the file and the value "done", got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("criterion 6b: each of the three allowed statuses is silent, and a missing one is still a PROBLEM", () => {
  // The vocabulary check must not shadow the presence check flow-0063 shipped: absent is a
  // PROBLEM, and "outside the three" is a warning about a value that is actually there.
  for (const status of INTENT_STATUSES) {
    const d = fixture({ "0001-a.md": task("P-0001") }, { intents: { "s.md": intent("s", { status }) } });
    const r = runDoctor({ flowDir: d });
    assert.deepEqual(r.warnings.filter((w) => w.includes("status")), [],
      `"${status}" is in the vocabulary and must be silent, got ${JSON.stringify(r.warnings)}`);
    cleanup(d);
  }
  const d = fixture({ "0001-a.md": task("P-0001") }, { intents: { "s.md": intent("s", { omit: ["status"] }) } });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes(".flow/intents/s.md") && p.includes("status")),
    `a missing status is still a required-field PROBLEM, got ${JSON.stringify(r.problems)}`);
  cleanup(d);
});

test("criterion 7: `supersedes` naming an id no intent declares → WARNING naming file and missing id", () => {
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: { "replacement.md": intent("replacement", { supersedes: "never-written" }) },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.includes(".flow/intents/replacement.md") && w.includes("never-written")),
    `expected a warning naming the file and the missing id, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("criterion 7b: a `supersedes` that resolves is silent — including a forward reference", () => {
  // The store is read whole before any file is checked. Read file-by-file instead and "z.md
  // supersedes a-old" would warn purely because `z` sorts after `a`, which is a bug that only
  // shows up on some filenames.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: {
      "a-newer.md": intent("a-newer", { supersedes: "z-older" }),   // names an id LATER in sort order
      "z-older.md": intent("z-older", { status: "superseded" }),
      "empty.md": intent("empty", { supersedes: "" }),
    },
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings.filter((w) => w.includes("supersedes")), [],
    `a resolvable (or empty) supersedes must be silent, got ${JSON.stringify(r.warnings)}`);
  cleanup(d);
});

test("criterion 8: `[assumption]` lines are never reported, and `approved` is no exception", () => {
  // The one rule stated as an absence. An intent may be approved with assumptions still standing
  // in it — that is why they are marked — so a checker that mentioned them at any status would
  // teach authors to stop marking, which costs the marker everything it is worth.
  const body = [
    "\n## Constraints\n",
    "[assumption] Three options is enough granularity.",
    "- [assumption] Weekly is the right default.",
    "\n## Open questions\n",
    "- What happens to the people already on the list?\n",
  ].join("\n");
  for (const status of ["proposed", "approved", "superseded"]) {
    const d = fixture({ "0001-a.md": task("P-0001") }, {
      intents: { "guessy.md": intent("guessy", { status, body }) },
    });
    const r = runDoctor({ flowDir: d });
    assert.deepEqual(r.problems, [], `status ${status}: ${JSON.stringify(r.problems)}`);
    assert.deepEqual(r.warnings.filter((w) => /assumption/i.test(w)), [],
      `status ${status}: an assumption line must never be reported, got ${JSON.stringify(r.warnings)}`);
    cleanup(d);
  }
});

test("intentFindings resolves `serves` only when handed a goal map — the switch, stated directly", () => {
  // The unit-level statement of criteria 4 and 5, so the on/off switch is provable without a
  // whole repo fixture around it, and cannot be satisfied by some other check going quiet.
  const d = fixture({ "0001-a.md": task("P-0001") }, {
    intents: { "x.md": intent("x", { serves: '["G404"]' }) },
  });
  const dir = join(d, "intents");
  assert.deepEqual(intentFindings(dir).warnings, [], "no goal map → the serves check is off");
  assert.deepEqual(intentFindings(dir, { goals: null }).warnings, [], "an explicit null → the serves check is off");
  const { goals } = parseVisionGoals(VISION);
  assert.equal(intentFindings(dir, { goals }).warnings.length, 1, "a goal map → the check resolves");
  assert.equal(intentFindings(dir, { goals }).count, 1);
  cleanup(d);
});

test("criterion 9: changes/flow-0073.md exists and describes the additions",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // Pending: the fragment file. After a release's `--assemble`: the same entry, folded into
    // CHANGELOG.md, and the fragment deleted by design. Read whichever holds it.
    const fragPath = join(canonicalRoot, "changes", "flow-0073.md");
    const fragment = existsSync(fragPath)
      ? readFileSync(fragPath, "utf8")
      : readFileSync(join(canonicalRoot, "CHANGELOG.md"), "utf8")
          .split(/\n(?=- \*\*)/).find((e) => e.startsWith("- **") && /`, flow-0073\)/.test(e)) ?? "";
    for (const thing of ["serves", "supersedes", "[assumption]", "Open questions"])
      assert.ok(fragment.includes(thing), `the changelog fragment does not mention ${thing}`);
    assert.match(fragment, /flow-0073/, "the fragment does not name the task it belongs to");
  });

// ── store identity: one id, one file (flow-0052) ───────────────────────────────────────────
// `allocate-task-id.mjs` allocates correctly but cannot make itself mandatory: the id lives in
// the FILENAME as well as the frontmatter, so two sessions that each pick `flow-0049` write two
// different paths, git merges both cleanly, and the store is left holding one id twice. That
// happened on canonical's `main` on 2026-09-15. Nothing mechanical reported it; a human noticed.
// These tests are the mechanism that would have.

test("criterion 1: two files, one id → a problem naming the id AND both paths", () => {
  const d = fixture({
    "flow-0049-ceiling.md": task("flow-0049"),
    "flow-0049-queue-runner.md": task("flow-0049"),
  });
  const r = runDoctor({ flowDir: d });
  const dup = r.problems.filter((p) => p.includes("duplicate id flow-0049"));
  assert.equal(dup.length, 1, `expected exactly one grouped message, got:\n${r.problems.join("\n")}`);
  assert.match(dup[0], /\.flow\/tasks\/flow-0049-ceiling\.md/);
  assert.match(dup[0], /\.flow\/tasks\/flow-0049-queue-runner\.md/,
    "naming only one side leaves the reader to go find the other — the fix is choosing between them");
  cleanup(d);
});

test("criterion 1: the CLI exits NON-ZERO on a duplicate id — the half CI actually reads", () => {
  const d = cliFixture({
    "flow-0049-ceiling.md": task("flow-0049"),
    "flow-0049-queue-runner.md": task("flow-0049"),
  });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*duplicate id flow-0049/);
  cleanup(d);
});

test("criterion 2: three files, one id → EVERY offending path is named, not the first two", () => {
  const d = fixture({
    "flow-0049-a.md": task("flow-0049"),
    "flow-0049-b.md": task("flow-0049"),
    "flow-0049-c.md": task("flow-0049"),
  });
  const r = runDoctor({ flowDir: d });
  const dup = r.problems.filter((p) => p.includes("duplicate id flow-0049"));
  assert.equal(dup.length, 1);
  for (const n of ["a", "b", "c"])
    assert.match(dup[0], new RegExp(`flow-0049-${n}\\.md`),
      `flow-0049-${n}.md is unnamed — a pairwise chain reports each file against only its ` +
      "predecessor, so the reader never sees the whole collision at once");
  cleanup(d);
});

test("criterion 3: two DISTINCT ids whose files sort adjacently pass — not a proximity heuristic", () => {
  const d = fixture({
    "flow-0049-ceiling.md": task("flow-0049"),
    "flow-0050-queue-runner.md": task("flow-0050"),
  });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, [], "adjacent filenames sharing a slug prefix are not a collision");
  assert.equal(r.count, 2);
  cleanup(d);
});

test("criterion 4: frontmatter id disagreeing with the filename id is a problem naming BOTH", () => {
  // The 2026-09-15 collision was cleared by a rename. A rename that forgets the frontmatter
  // re-creates the same ambiguity one layer down: findable under one id, self-describing as
  // another. The store then has no single answer to "which file is flow-0050?".
  const d = fixture({ "flow-0050-queue-runner.md": task("flow-0049") });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.problems.length, 1, r.problems.join("\n"));
  assert.match(r.problems[0], /flow-0050-queue-runner\.md/, "the filename must be named");
  assert.match(r.problems[0], /"flow-0049"/, "the frontmatter id must be named");
  assert.match(r.problems[0], /"flow-0050"/, "the filename's id must be named");
  cleanup(d);
});

test("criterion 4: the CLI exits NON-ZERO on a filename/frontmatter disagreement", () => {
  const d = cliFixture({ "flow-0050-queue-runner.md": task("flow-0049") });
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL.*disagrees with the id in its own filename/);
  cleanup(d);
});

test("a filename that declares no id at all is not a disagreement", () => {
  // `project-template/.flow/tasks/0001-newsletter-signup.md` is exactly this shape, and adopting
  // repos inherit it. A name with no `PREFIX-1234` opening declares nothing to disagree WITH.
  const d = fixture({ "0001-newsletter-signup.md": task("PROJ-0001") });
  assert.deepEqual(runDoctor({ flowDir: d }).problems, []);
  cleanup(d);
});

test("a duplicate cannot hide behind an unrelated missing field in one of its halves", () => {
  // The id is registered BEFORE the required-field and status guards `continue`. Registering it
  // after would mean one malformed half suppressed the collision report for both.
  const d = fixture({
    "flow-0049-a.md": task("flow-0049"),
    "flow-0049-b.md": task("flow-0049", { status: "shipping" }),
  });
  const r = runDoctor({ flowDir: d });
  assert.ok(r.problems.some((p) => p.includes('illegal status "shipping"')));
  const dup = r.problems.filter((p) => p.includes("duplicate id flow-0049"));
  assert.equal(dup.length, 1, r.problems.join("\n"));
  assert.match(dup[0], /flow-0049-b\.md/);
  cleanup(d);
});

test("filenameTaskId reads the id a filename declares, and nothing it does not", () => {
  assert.equal(filenameTaskId("flow-0052-duplicate-task-id.md"), "flow-0052");
  assert.equal(filenameTaskId("flow-0052.md"), "flow-0052");
  assert.equal(filenameTaskId("flow-00521-x.md"), "flow-00521",
    "a longer number is its own id, never a prefix match against a shorter one");
  assert.equal(filenameTaskId("PROJ_X-7-thing.md"), "PROJ_X-7");
  assert.equal(filenameTaskId("0001-newsletter-signup.md"), null);
  assert.equal(filenameTaskId("_TEMPLATE.md"), null);
  assert.equal(filenameTaskId("notes.md"), null);
});

test("duplicateIdProblems: silent on a clean list, ignores entries with no id", () => {
  assert.deepEqual(duplicateIdProblems([]), []);
  assert.deepEqual(duplicateIdProblems([{ path: "a.md", id: "P-1" }, { path: "b.md", id: "P-2" }]), []);
  assert.deepEqual(duplicateIdProblems([{ path: "a.md", id: "" }, { path: "b.md", id: undefined }]), [],
    "a file with no parseable id is a MALFORMED-frontmatter finding, not a collision");
});

test("duplicateIdProblems: reports every duplicated id, each in its own message", () => {
  const out = duplicateIdProblems([
    { path: "a.md", id: "P-1" }, { path: "b.md", id: "P-2" },
    { path: "c.md", id: "P-1" }, { path: "d.md", id: "P-2" },
  ]);
  assert.equal(out.length, 2, "two independent collisions must not be folded into one line");
  assert.ok(out.some((p) => p.includes("P-1") && p.includes("a.md") && p.includes("c.md")));
  assert.ok(out.some((p) => p.includes("P-2") && p.includes("b.md") && p.includes("d.md")));
});

test("criterion 5: canonical's OWN store holds no duplicate id and no filename disagreement",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // The check is added green. `gitStatus` is injected so an in-flight working tree cannot make
    // this assert the uncommitted-task guard instead of the thing under test.
    const { problems } = runDoctor({
      flowDir: join(canonicalRoot, ".flow"),
      gitStatus: () => ({ inRepo: false, porcelain: "" }),
    });
    assert.deepEqual(problems.filter((p) => p.includes("duplicate id")), []);
    assert.deepEqual(problems.filter((p) => p.includes("disagrees with the id in its own filename")), []);
  });

test("criterion 6: canonical's .flow/bin/flow-doctor.mjs ADAPTS this scan — it does not copy it",
  { skip: inCanonical ? false : "not canonical" }, () => {
    // Asserted the way `.flow/bin/adapters.test.mjs` asserts the other adapters: a copy here
    // would put the fleet's store invariant in a file no adopting repo ever receives, and a
    // symlink would resolve its realpath back into project-template/ and validate the FIXTURE
    // store while still exiting 0.
    const file = join(canonicalRoot, ".flow", "bin", "flow-doctor.mjs");
    assert.ok(!lstatSync(file).isSymbolicLink(), "a symlink would read the template's fixture store");
    const src = readFileSync(file, "utf8");
    assert.match(src, /export \{[^}]*\bduplicateIdProblems\b[^}]*\} from "\.\.\/\.\.\/project-template\/\.flow\/bin\/flow-doctor\.mjs"/,
      "the adapter must re-export the template's scan — one implementation, not two");
    for (const fn of ["duplicateIdProblems", "filenameIdProblems", "filenameTaskId"])
      assert.ok(!new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
        `${fn} is re-implemented in the adapter — that is the drift this criterion forbids`);
  });

// ── asks (flow-0119) ──
// `asks` is the queue for the human, and its consumers (the PR comment, inflight) route on the
// kind. A malformed entry they cannot read would be dropped silently — the exact bug `asks` was
// written to fix, one layer further down. So flow-doctor fails it on `main`, before any consumer
// ever sees the store.

test("criterion 3: flow-doctor fails a task whose decision ask carries no Recommend:", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { asks: ["decision: pick one"] }) });
  const r = runDoctor({ flowDir: d });
  const hit = r.problems.filter((p) => p.includes("P-0001") && /Recommend/.test(p));
  assert.equal(hit.length, 1, `expected one problem naming the task and the clause, got ${JSON.stringify(r.problems)}`);
  assert.match(hit[0], /decision: pick one/, "the problem must quote the ask, not just the task");
  cleanup(d);
});

test("criterion 3: flow-doctor fails an unknown ask kind, naming the task and the ask", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { asks: ["todo: x"] }) });
  const r = runDoctor({ flowDir: d });
  const hit = r.problems.filter((p) => p.startsWith("P-0001:") && /unknown kind "todo"/.test(p));
  assert.equal(hit.length, 1, JSON.stringify(r.problems));
  cleanup(d);
});

test("criterion 3: flow-doctor fails an ask with empty text", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { asks: ["fyi:"] }) });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.problems.filter((p) => p.startsWith("P-0001:") && /empty text/.test(p)).length, 1,
    JSON.stringify(r.problems));
  cleanup(d);
});

test("criterion 3: flow-doctor passes a task carrying one valid ask of each kind", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { asks: [
    "decision: v2 or v3 in the schema id? Recommend: v3, the id should say the shape",
    "follow-up: the retry path needs its own task, it is out of scope here",
    "fyi: the fixture store moved, so a stale checkout fails one test",
  ] }) });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, [], "a valid asks list must not even warn");
  cleanup(d);
});

test("every malformed ask on a task is reported, not just the first", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { asks: ["todo: x", "fyi:", "decision: pick one"] }) });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.problems.filter((p) => p.startsWith("P-0001:")).length, 3, JSON.stringify(r.problems));
  cleanup(d);
});

test("criterion 4: a task with no asks field at all is healthy", () => {
  // Every task in every already-adopted repo. Unlike `blocked_by`, this check CANNOT trip on
  // history — an absent key parses as an empty list — so the findings above can be problems
  // rather than warnings without punishing anyone for the past.
  const d = fixture({ "0001-a.md": task("P-0001") });
  assert.doesNotMatch(readFileSync(join(dirname(d), ".flow", "tasks", "0001-a.md"), "utf8"), /^asks:/m,
    "the fixture must genuinely omit the field, or this proves nothing");
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("asksFindings on a task object: absent, empty and valid all find nothing", () => {
  for (const asksList of [undefined, [], ["fyi: all good"]])
    assert.deepEqual(asksFindings({ id: "P-1", asksList }), { problems: [], warnings: [] });
});

test("asksFindings prefixes every finding with the task id", () => {
  const { problems, warnings } = asksFindings({ id: "P-1", asksList: ["todo: x"] });
  assert.equal(warnings.length, 0, "a malformed ask is a problem, never a warning");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^P-1: /);
});

test("the inline asks form parses too, like every other list field in the store", () => {
  // `parseListField` reads both YAML list shapes; an ask written inline must not read as absent,
  // because "absent" is the one state that raises nothing at all.
  const body = task("P-0001").replace(/^serves:/m, 'asks: ["todo: x"]\nserves:');
  const d = fixture({ "0001-a.md": body });
  assert.equal(runDoctor({ flowDir: d }).problems.filter((p) => /unknown kind "todo"/.test(p)).length, 1);
  cleanup(d);
});

// Code review on #175. flow-doctor must judge the ask the author WROTE, not a version cut at its
// first `#`: a legal ask quoting an issue number is clean, and a malformed one is quoted back whole.
test("flow-0119: an ask carrying `#` is read whole by flow-doctor, in block and inline lists", async () => {
  const { parseListField, yamlScalar } = await import("./flow-doctor.mjs");
  assert.deepEqual(parseListField(`asks:\n  - "fyi: see PR #127 for context"  # note\n`, "asks"),
    ["fyi: see PR #127 for context"]);
  assert.deepEqual(parseListField(`asks: ["fyi: see #127", 'follow-up: it''s #9'] # c\n`, "asks"),
    ["fyi: see #127", "follow-up: it's #9"]);
  assert.deepEqual(parseListField(`touches:\n  - src/a.ts # why\n  - "b/**"\n`, "touches"), ["src/a.ts", "b/**"],
    "an unquoted entry with a trailing comment is still cut at the comment");
  assert.equal(yamlScalar(`"waits for #172 \\"x\\"" # note`), 'waits for #172 "x"');
  assert.equal(yamlScalar(`ready # c`), "ready");
  assert.deepEqual(asksFindings({ id: "CAN-1", asksList: parseListField(`asks:\n  - "decision: #12 or #13? Recommend: #13"\n`, "asks") }).problems, [],
    "a legal ask with # in it is not a finding");
});

// Code review on #175, second pass: an apostrophe inside a PLAIN value is not a quote. Treating it
// as one kept a genuine trailing comment in the data ("it's simpler # ask Dan" leaked into recommend).
test("flow-0119: an apostrophe in an unquoted value does not open a quote, so a trailing comment is still dropped", async () => {
  const { parseListField, yamlScalar } = await import("./flow-doctor.mjs");
  assert.deepEqual(
    parseListField(`asks:\n  - decision: v2 or v3? Recommend: v3, it's simpler # ask Dan directly\n`, "asks"),
    ["decision: v2 or v3? Recommend: v3, it's simpler"]);
  assert.equal(yamlScalar(`don't # note`), "don't");
  assert.equal(yamlScalar(`'it''s #1' # note`), "it's #1", "a single-quoted scalar still keeps its # and its escaped quote");
  assert.deepEqual(parseListField(`asks: ["fyi: it's #1", 'follow-up: x'] # c\n`, "asks"), ["fyi: it's #1", "follow-up: x"]);
});

// ── tasks derive from intents (flow-0074, ADR-0007 slice 2) ─────────────────────────────────
// Each test below proves one acceptance criterion of flow-0074, numbered as the task numbers
// them. The CLI runs prove the exit code, which is the half CI actually reads.
const intentWarnings = (r) => r.warnings.filter((w) => /\bintent\b|intents\.required_from/.test(w));
const NEW_PRODUCT_TASK = { created: "2026-10-02", serves: '["G1"]' };

test("flow-0074 criterion 1: a new ready product task with no intent warns, naming the task, and exits 0", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", NEW_PRODUCT_TASK) }, { requiredFrom: "2026-10-01" });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: false }) });
  assert.deepEqual(r.problems, []);
  const w = intentWarnings(r);
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /^P-0001: ready with no intent/);
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  assert.match(out, /WARN\s+P-0001: ready with no intent/);
  cleanup(d);
});

test("flow-0074 criterion 1: the cutoff day itself counts — created ON required_from warns", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-10-01" }) }, { requiredFrom: "2026-10-01" });
  assert.equal(intentWarnings(runDoctor({ flowDir: d })).length, 1);
  cleanup(d);
});

test("flow-0074 criterion 1: a datetime `created` is compared by its date", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-10-02T09:00:00Z" }) }, { requiredFrom: "2026-10-01" });
  assert.equal(intentWarnings(runDoctor({ flowDir: d })).length, 1);
  cleanup(d);
});

test("flow-0074: an empty `serves` is not an exemption — only a maintenance-only serves is", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-10-02", serves: "[]" }) },
    { requiredFrom: "2026-10-01" });
  assert.ok(intentWarnings(runDoctor({ flowDir: d })).some((w) => w.startsWith("P-0001: ready with no intent")));
  cleanup(d);
});

test("flow-0074: the missing-intent rule is ready-only — an in_progress task with no intent is not asked", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { ...NEW_PRODUCT_TASK, status: "in_progress", owner: "s", started: "2026-10-02T00:00:00Z" }) },
    { requiredFrom: "2026-10-01" });
  assert.deepEqual(intentWarnings(runDoctor({ flowDir: d })), []);
  cleanup(d);
});

test("flow-0074 criterion 2: a ready task created before required_from is never asked for an intent", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-09-30" }) }, { requiredFrom: "2026-10-01" });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(intentWarnings(r), []);
  cleanup(d);
});

test("flow-0074 criterion 3: serves [\"maintenance\"] with no intent reports nothing", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-10-02", serves: '["maintenance"]' }) },
    { requiredFrom: "2026-10-01" });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(intentWarnings(r), []);
  cleanup(d);
});

test("flow-0074 criterion 3: maintenance PLUS a goal is product work, and still warns", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { created: "2026-10-02", serves: '["maintenance", "G1"]' }) },
    { requiredFrom: "2026-10-01" });
  assert.equal(intentWarnings(runDoctor({ flowDir: d })).length, 1);
  cleanup(d);
});

test("flow-0074 criterion 4: a ready task naming an unknown intent is a PROBLEM naming both, and exits 1", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { intent: "no-such-intent" }) },
    { intents: { "real.md": intent("real") } });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: false }) });
  const p = r.problems.filter((x) => x.includes("no-such-intent"));
  assert.equal(p.length, 1, JSON.stringify(r.problems));
  assert.match(p[0], /^P-0001: intent "no-such-intent" names no intent/);
  const { code, out } = runCli(d);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL\s+P-0001: intent "no-such-intent"/);
  cleanup(d);
});

test("flow-0074 criterion 4: the same dangling intent on an in_progress task is a WARNING, and exits 0", () => {
  const d = cliFixture({ "0001-a.md": task("P-0001", { intent: "no-such-intent", status: "in_progress", owner: "s", started: "2026-10-02T00:00:00Z" }) },
    { intents: { "real.md": intent("real") } });
  const r = runDoctor({ flowDir: d, gitStatus: () => ({ inRepo: false }) });
  assert.deepEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => w.startsWith('P-0001: intent "no-such-intent" names no intent')), JSON.stringify(r.warnings));
  const { code, out } = runCli(d);
  assert.equal(code, 0, out);
  cleanup(d);
});

test("flow-0074 criterion 5: an intent with status proposed resolves — presence on main is approval", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { ...NEW_PRODUCT_TASK, intent: "waiting" }) },
    { intents: { "waiting.md": intent("waiting", { status: "proposed" }) }, requiredFrom: "2026-10-01" });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  cleanup(d);
});

test("flow-0074 criterion 6: an intent that is superseded warns, naming the task and the intent", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { intent: "old-mind" }) },
    { intents: { "old-mind.md": intent("old-mind", { status: "superseded" }) } });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const w = r.warnings.filter((x) => x.includes("superseded"));
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /P-0001/);
  assert.match(w[0], /old-mind/);
  cleanup(d);
});

test("flow-0074 criterion 7: a store with required_from unset warns exactly once, naming the key, and asks no task", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", NEW_PRODUCT_TASK),
    "0002-b.md": task("P-0002", NEW_PRODUCT_TASK),
  }, { requiredFrom: null });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const w = intentWarnings(r);
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.ok(w[0].includes(INTENTS_REQUIRED_FROM_KEY));
  assert.ok(!w.some((x) => x.includes("P-000")), "no per-task missing-intent warning while the key is unset");
  cleanup(d);
});

test("flow-0074 criterion 7: a required_from that is not a date also switches the rule off, once, saying so", () => {
  const d = fixture({ "0001-a.md": task("P-0001", NEW_PRODUCT_TASK) }, { requiredFrom: "soon" });
  const w = intentWarnings(runDoctor({ flowDir: d }));
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /intents\.required_from is "soon", not a YYYY-MM-DD date/);
  cleanup(d);
});

test("flow-0074 criterion 7: the key is still read with a dangling intent — that check never depends on the date", () => {
  const d = fixture({ "0001-a.md": task("P-0001", { intent: "ghost" }) }, { requiredFrom: null });
  assert.ok(runDoctor({ flowDir: d }).problems.some((p) => p.includes('"ghost"')));
  cleanup(d);
});

test("flow-0074 criterion 8: with no .flow/intents/, the intent rules add nothing beyond the absent-store warning", () => {
  const d = fixture({
    "0001-a.md": task("P-0001", { ...NEW_PRODUCT_TASK, intent: "ghost" }),
    "0002-b.md": task("P-0002", NEW_PRODUCT_TASK),
  }, { intents: null });
  const r = runDoctor({ flowDir: d });
  assert.deepEqual(r.problems, []);
  const w = r.warnings.filter((x) => /intent/i.test(x));
  assert.equal(w.length, 1, JSON.stringify(r.warnings));
  assert.match(w[0], /^no \.flow\/intents\//);
  assert.deepEqual(taskIntentFindings([{ id: "X", status: "ready", intent: "ghost" }], null, undefined),
    { problems: [], warnings: [] });
  cleanup(d);
});

test("flow-0074: parseIntentsRequiredFrom reads the nested key, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-rf-"));
  const at = (yaml) => { const p = join(dir, "config.yml"); writeFileSync(p, yaml); return parseIntentsRequiredFrom(p); };
  assert.equal(parseIntentsRequiredFrom(join(dir, "absent.yml")), undefined);
  assert.equal(at('intents:\n  required_from: "2026-10-06"   # adopted\n'), "2026-10-06");
  assert.equal(at("intents:  # the layer\n  # a comment\n  required_from: 2026-10-06\n"), "2026-10-06");
  assert.equal(at('# intents:\n#   required_from: "YYYY-MM-DD"\n'), undefined, "the shipped commented-out form is unset");
  assert.equal(at('intents:\n  other: 1\ngit:\n  required_from: "2026-10-06"\n'), undefined, "a same-named key under another block is not it");
  assert.equal(at('required_from: "2026-10-06"\n'), undefined, "a top-level key is not it");
  rmSync(dir, { recursive: true, force: true });
});

// The task template ships in an adopting repo too (flow-sync does not touch a repo's own copy, but
// flow-init scaffolds it), so this reads the template beside this file wherever it runs.
const TASK_TEMPLATE_PATH = join(import.meta.dirname, "..", "tasks", "_TEMPLATE.md");
test("flow-0074 criterion 9: the task _TEMPLATE.md declares `intent` as an empty string, and doctor ignores the template",
  { skip: existsSync(TASK_TEMPLATE_PATH) ? false : "no .flow/tasks/_TEMPLATE.md beside this file" }, () => {
  const text = readFileSync(TASK_TEMPLATE_PATH, "utf8");
  const head = text.slice(3, text.indexOf("\n---", 3));
  const m = head.match(/^intent:\s*(.*)$/m);
  assert.ok(m, "the template must declare `intent:`");
  assert.match(m[1], /^""(\s|$)/, "`intent` ships as an empty string");
  if (yamlParse) assert.equal(yamlParse(head).intent, "", "and a YAML parser reads it as an empty string");
  const d = fixture({ "_TEMPLATE.md": text, "0001-a.md": task("P-0001") }, { requiredFrom: "2000-01-01" });
  const r = runDoctor({ flowDir: d });
  assert.equal(r.count, 1, "the template is not a task");
  assert.ok(![...r.problems, ...r.warnings].some((x) => x.includes("PROJ-0000")), JSON.stringify(r));
  cleanup(d);
});

test("flow-0074 criterion 12: canonical sets intents.required_from, and its own doctor reports no problem from the intent rules",
  { skip: inCanonical ? false : "canonical-only: reads canonical's own .flow/" }, () => {
  const canonFlow = join(canonicalRoot, ".flow");
  const rf = parseIntentsRequiredFrom(join(canonFlow, "config.yml"));
  assert.match(rf ?? "", /^\d{4}-\d{2}-\d{2}$/, "canonical's .flow/config.yml sets intents.required_from");
  const r = runDoctor({ flowDir: canonFlow, gitStatus: () => ({ inRepo: false }) });
  assert.deepEqual(r.problems.filter((p) => /\bintent\b|intents\.required_from/.test(p)), []);
  assert.ok(!r.warnings.some((w) => w.includes(INTENTS_REQUIRED_FROM_KEY)), "the key is set, so no unset-key warning");
});
