// intake-config.test.mjs — proving tests for flow-0200: "Add an `intake:` block to the config
// template, read by one parser that trusts no labeler by default". Each test names the criterion
// it proves. The parser is pure (text in, object out), so every test hands it config text directly
// except the last, which reads the shipped template file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { INTAKE_DEFAULTS, readIntakeConfig } from "./intake-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The template's config, present only in canonical. An adopting repo's `.flow/bin` sits beside its
// OWN config, which legitimately names its App's login, so asserting the template's empty default
// there would be asserting the wrong file.
const TEMPLATE_CONFIG = (() => {
  const root = resolve(HERE, "..", "..", "..");
  const path = join(root, "project-template", ".flow", "config.yml");
  const isCanon = existsSync(path) && existsSync(join(root, ".flow", "bin"));
  return isCanon ? path : null;
})();

const BASE = 'project:\n  name: "x"\ncoverage_min: 80\n';
const intake = (body) => `${BASE}intake:\n${body}git:\n  base_branch: "main"\n`;

// ── criterion 1: no block → every restrictive default ──────────────────────────────────────

test("criterion 1: config with no intake: block → trustedLabelers [], classifierModel haiku, maxChangedLines 20", () => {
  assert.deepEqual(readIntakeConfig(BASE),
    { trustedLabelers: [], classifierModel: "haiku", maxChangedLines: 20 });
});

test("criterion 1: empty, null and undefined input all read as the defaults and never throw", () => {
  for (const input of ["", null, undefined]) {
    assert.deepEqual(readIntakeConfig(input),
      { trustedLabelers: [], classifierModel: "haiku", maxChangedLines: 20 });
  }
});

test("criterion 1: a COMMENTED-OUT intake: block is not a block", () => {
  const text = `${BASE}# intake:\n#   trusted_labelers: ["mallory"]\n#   trivial:\n#     max_changed_lines: 999\n`;
  assert.deepEqual(readIntakeConfig(text),
    { trustedLabelers: [], classifierModel: "haiku", maxChangedLines: 20 });
});

test("criterion 1: the exported defaults are the restrictive ones, and frozen", () => {
  assert.deepEqual(INTAKE_DEFAULTS, { trustedLabelers: [], classifierModel: "haiku", maxChangedLines: 20 });
  assert.ok(Object.isFrozen(INTAKE_DEFAULTS) && Object.isFrozen(INTAKE_DEFAULTS.trustedLabelers));
  readIntakeConfig(BASE).trustedLabelers.push("x"); // a caller mutating its result…
  assert.deepEqual(readIntakeConfig(BASE).trustedLabelers, []); // …never changes the next one
});

// ── criterion 2: inline and block lists both read, in order, quotes stripped ───────────────

test("criterion 2: inline trusted_labelers list → exactly the two logins, in order, quotes stripped", () => {
  const text = intake('  trusted_labelers: ["inflight-flow[bot]", "other[bot]"]\n');
  assert.deepEqual(readIntakeConfig(text).trustedLabelers, ["inflight-flow[bot]", "other[bot]"]);
});

test("criterion 2: block trusted_labelers list → exactly the two logins, in order, quotes stripped", () => {
  const text = intake('  trusted_labelers:\n    - "inflight-flow[bot]"\n    - "other[bot]"\n');
  assert.deepEqual(readIntakeConfig(text).trustedLabelers, ["inflight-flow[bot]", "other[bot]"]);
});

test("criterion 2: single quotes, bare logins, trailing comments and blank/comment lines inside a block list", () => {
  assert.deepEqual(
    readIntakeConfig(intake("  trusted_labelers: ['a-bot[bot]', dan]   # two of them\n")).trustedLabelers,
    ["a-bot[bot]", "dan"]);
  assert.deepEqual(
    readIntakeConfig(intake("  trusted_labelers:   # who\n    - 'a-bot[bot]'  # the app\n\n    # a person:\n    - dan\n")).trustedLabelers,
    ["a-bot[bot]", "dan"]);
});

test("criterion 2: CRLF line endings read the same as LF", () => {
  const text = intake('  trusted_labelers:\n    - "inflight-flow[bot]"\n    - "other[bot]"\n').replace(/\n/g, "\r\n");
  assert.deepEqual(readIntakeConfig(text).trustedLabelers, ["inflight-flow[bot]", "other[bot]"]);
});

// ── criterion 3: empty, empty-valued or malformed → [] ─────────────────────────────────────

test("criterion 3: trusted_labelers: [] → []", () => {
  assert.deepEqual(readIntakeConfig(intake("  trusted_labelers: []\n")).trustedLabelers, []);
  assert.deepEqual(readIntakeConfig(intake("  trusted_labelers: [  ]\n")).trustedLabelers, []);
});

test("criterion 3: an empty value → [], including one followed by the next key", () => {
  assert.deepEqual(readIntakeConfig(intake("  trusted_labelers:\n")).trustedLabelers, []);
  assert.deepEqual(readIntakeConfig(intake('  trusted_labelers:\n  classifier_model: "haiku"\n')).trustedLabelers, []);
  assert.deepEqual(readIntakeConfig(`${BASE}intake:\n  trusted_labelers:`).trustedLabelers, []);
});

test("criterion 3: malformed values → [], never a wildcard, an empty string or the raw text", () => {
  const malformed = [
    '  trusted_labelers: ["inflight-flow[bot]", "other[bot]"\n', // unterminated [
    '  trusted_labelers: [\n',                                   // bare [
    '  trusted_labelers: ["*"]\n',                               // wildcard
    "  trusted_labelers: [*]\n",
    '  trusted_labelers: "*"\n',                                 // scalar wildcard
    "  trusted_labelers: dan\n",                                 // a scalar is not a list
    '  trusted_labelers: ["dan", ""]\n',                         // empty entry
    '  trusted_labelers: ["dan",,"eve"]\n',                      // empty entry by double comma
    '  trusted_labelers: ["dan", ]\n',                           // trailing comma
    '  trusted_labelers: ["dan eve"]\n',                         // whitespace in a login
    '  trusted_labelers: ["-dan"]\n',                            // not a GitHub login
    '  trusted_labelers: ["dan--eve"]\n',
    `  trusted_labelers: ["${"a".repeat(40)}"]\n`,               // longer than GitHub allows
    "  trusted_labelers:\n    - dan\n    - \n",                   // empty block item
    "  trusted_labelers:\n    - dan\n    -\n",
    '  trusted_labelers:\n    - "*"\n',                          // wildcard block item
    "  trusted_labelers:\n    - dan\n    nonsense: true\n",      // a non-item inside the list
    "  trusted_labelers:\n    - [dan, eve]\n",                   // nested list
  ];
  for (const body of malformed) {
    const got = readIntakeConfig(intake(body)).trustedLabelers;
    assert.deepEqual(got, [], `expected [] for ${JSON.stringify(body)}, got ${JSON.stringify(got)}`);
  }
});

test("criterion 3: a malformed list does not take the rest of the block down with it", () => {
  const text = intake('  trusted_labelers: ["dan"\n  classifier_model: "sonnet"\n  trivial:\n    max_changed_lines: 40\n');
  assert.deepEqual(readIntakeConfig(text),
    { trustedLabelers: [], classifierModel: "sonnet", maxChangedLines: 40 });
});

// ── criterion 4: max_changed_lines ─────────────────────────────────────────────────────────

test("criterion 4: max_changed_lines: 50 → 50 (bare, quoted, or with a trailing comment)", () => {
  for (const v of ["50", '"50"', "'50'", "50   # lines"]) {
    assert.equal(readIntakeConfig(intake(`  trivial:\n    max_changed_lines: ${v}\n`)).maxChangedLines, 50, v);
  }
});

test("criterion 4: 0, negative, non-integer or non-numeric max_changed_lines → the default 20", () => {
  for (const v of ["0", "-5", "12.5", "1e3", "twenty", '""', "", "[50]", "99999999999999999999", "0x20"]) {
    assert.equal(readIntakeConfig(intake(`  trivial:\n    max_changed_lines: ${v}\n`)).maxChangedLines, 20,
      `max_changed_lines: ${v}`);
  }
});

test("criterion 4: max_changed_lines is read only under trivial:, never as a direct intake key or a scalar trivial", () => {
  assert.equal(readIntakeConfig(intake("  max_changed_lines: 50\n")).maxChangedLines, 20);
  assert.equal(readIntakeConfig(intake("  trivial: 50\n")).maxChangedLines, 20);
  assert.equal(readIntakeConfig(intake("  trivial:\n  max_changed_lines: 50\n")).maxChangedLines, 20);
});

// ── criterion 5: keys under other top-level blocks are not the intake list ──────────────────

test("criterion 5: trusted_labelers under review: is not read as the intake list", () => {
  const text = `${BASE}review:\n  trusted_labelers: ["mallory[bot]"]\n  trivial:\n    max_changed_lines: 999\n` +
    "intake:\n  trusted_labelers: []\n";
  assert.deepEqual(readIntakeConfig(text).trustedLabelers, []);
  assert.equal(readIntakeConfig(text).maxChangedLines, 20);
});

test("criterion 5: trusted_labelers under review: with NO intake: block at all is not read either", () => {
  const text = `${BASE}review:\n  trusted_labelers:\n    - "mallory[bot]"\n  classifier_model: "opus"\n`;
  assert.deepEqual(readIntakeConfig(text),
    { trustedLabelers: [], classifierModel: "haiku", maxChangedLines: 20 });
});

test("criterion 5: a top-level trusted_labelers, or one nested deeper inside intake:, is not the list", () => {
  assert.deepEqual(readIntakeConfig(`${BASE}trusted_labelers: ["mallory"]\nintake:\n  classifier_model: "haiku"\n`).trustedLabelers, []);
  assert.deepEqual(readIntakeConfig(intake('  trivial:\n    trusted_labelers: ["mallory"]\n')).trustedLabelers, []);
});

test("criterion 5: the intake block ends at the next top-level key, so a later block's keys are never its own", () => {
  const text = `${BASE}intake:\n  classifier_model: "sonnet"\nother:\n  trusted_labelers: ["mallory"]\n`;
  assert.deepEqual(readIntakeConfig(text), { trustedLabelers: [], classifierModel: "sonnet", maxChangedLines: 20 });
});

// ── classifier_model, returned as written (task notes) ─────────────────────────────────────

test("classifier_model is returned as written, quotes stripped; empty falls back to haiku", () => {
  assert.equal(readIntakeConfig(intake('  classifier_model: "sonnet"\n')).classifierModel, "sonnet");
  assert.equal(readIntakeConfig(intake("  classifier_model: not-a-tier  # the classifier decides\n")).classifierModel, "not-a-tier");
  assert.equal(readIntakeConfig(intake("  classifier_model:\n")).classifierModel, "haiku");
  assert.equal(readIntakeConfig(intake('  classifier_model: ""\n')).classifierModel, "haiku");
});

// ── criterion 6: the shipped template ──────────────────────────────────────────────────────

test("criterion 6: project-template/.flow/config.yml yields trustedLabelers [] and maxChangedLines 20", (t) => {
  if (!TEMPLATE_CONFIG) return t.skip("canonical-only: this repo has no project-template/ to read");
  const text = readFileSync(TEMPLATE_CONFIG, "utf8");
  assert.match(text, /^intake:\s*$/m, "the template must actually carry the block, not lean on the defaults");
  const got = readIntakeConfig(text);
  assert.deepEqual(got.trustedLabelers, []);
  assert.equal(got.maxChangedLines, 20);
  assert.equal(got.classifierModel, "haiku");
});
