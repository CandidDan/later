// asks.test.mjs — node --test. The proving tests for flow-0119's `asks:` contract.
//
// `asks` is a field whose whole value is that something downstream can ROUTE on it: the PR
// comment and inflight read the kind and show the human only what the human can act on. So the
// tests that matter here are the grammar's edges (what is rejected, and with what sentence), the
// id's stability (the same ask must be recognisable across runs and repos), and the one property
// no unit test of behaviour can cover — that this module stays loadable in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ASK_KINDS, askId, normaliseAskText, parseAsk, parseAsks } from "./asks.mjs";

// ── criterion 1: a valid decision parses into its four parts, with a stable id ──

test("criterion 1: a decision ask yields kind, question, recommendation and an id", () => {
  const ask = parseAsk("decision: v2 or v3? Recommend: v3, the schema id says the shape");
  assert.equal(ask.error, undefined, "a well-formed decision must not be an error");
  assert.equal(ask.kind, "decision");
  assert.equal(ask.text, "v2 or v3?", "the question is the text with the Recommend clause split off");
  assert.equal(ask.recommend, "v3, the schema id says the shape");
  assert.ok(ask.id, "every parsed ask carries an id");
});

test("criterion 1: the same string returns the same id on every call", () => {
  const s = "decision: v2 or v3? Recommend: v3, the schema id says the shape";
  const first = parseAsk(s).id;
  for (let i = 0; i < 5; i++) assert.equal(parseAsk(s).id, first, "the id must not vary between calls");
  assert.equal(askId("decision: v2 or v3?"), askId("decision: v2 or v3?"));
  // The SAME id for the same ask written with different whitespace or case — a re-wrapped YAML
  // line is not a new ask. This is what lets a consumer say "already shown" rather than post twice.
  assert.equal(parseAsk("decision:   V2 or v3?   Recommend: v3, the schema id says the shape").id, first);
});

test("the id covers the kind and the question, never the recommendation", () => {
  // Rewording the recommendation is the worker improving its advice about the same open question.
  const a = parseAsk("decision: v2 or v3? Recommend: v3, the schema id says the shape");
  const b = parseAsk("decision: v2 or v3? Recommend: v2 on reflection, the client pins it");
  assert.equal(a.id, b.id, "a rewritten recommendation must not mint a new ask");
  // Rewording the QUESTION is a new ask, and the id must say so.
  const c = parseAsk("decision: v3 or v4? Recommend: v3, the schema id says the shape");
  assert.notEqual(a.id, c.id, "a different question must get a different id");
  // So must a different kind over identical text.
  assert.notEqual(parseAsk("fyi: the store moved").id, parseAsk("follow-up: the store moved").id);
});

test("ids are fixed-width base36, so a truncated one is visibly truncated", () => {
  for (const s of ["a", "decision: x", "x".repeat(500)]) assert.match(askId(s), /^[0-9a-z]{11}$/);
});

test("normaliseAskText collapses only what is not a difference", () => {
  assert.equal(normaliseAskText("  Pick\n  One  "), "pick one");
  assert.equal(normaliseAskText(undefined), "");
  // Punctuation is NOT stripped: two genuinely different questions must never collide.
  assert.notEqual(normaliseAskText("ship it"), normaliseAskText("ship it?"));
});

// ── criterion 2: the three malformed shapes are rejected ──

test("criterion 2: a decision with no Recommend: is an error naming the ask", () => {
  const r = parseAsk("decision: pick one");
  assert.ok(r.error, "a decision without a recommendation must not parse");
  assert.match(r.error, /decision: pick one/, "the error must quote the ask the author wrote");
  assert.match(r.error, /Recommend/, "the error must name the missing clause");
  assert.equal(r.kind, undefined, "an error result is never half-filled");
});

test("criterion 2: an unknown kind is an error naming the kind and the legal set", () => {
  const r = parseAsk("todo: x");
  assert.ok(r.error);
  assert.match(r.error, /unknown kind "todo"/);
  for (const kind of ASK_KINDS) assert.match(r.error, new RegExp(kind), `the error must list ${kind}`);
});

test("criterion 2: empty text is an error", () => {
  assert.match(parseAsk("fyi:").error, /empty text/);
  assert.match(parseAsk("fyi:    ").error, /empty text/);
  // A decision whose text is only the Recommend clause has no question, and reads as empty text.
  assert.match(parseAsk("decision: Recommend: v3").error, /empty text/);
});

test("an ask with no kind prefix at all is an error, not a silent fyi", () => {
  const r = parseAsk("please decide between v2 and v3");
  assert.ok(r.error);
  assert.match(r.error, /no kind prefix/);
  assert.match(parseAsk("").error, /empty ask/);
  assert.match(parseAsk(null).error, /empty ask/);
});

// ── the valid shapes of the other two kinds ──

test("follow-up and fyi parse with recommend null", () => {
  const f = parseAsk("follow-up: the retry path needs its own task");
  assert.equal(f.kind, "follow-up");
  assert.equal(f.text, "the retry path needs its own task");
  assert.equal(f.recommend, null, "only a decision is required to recommend; absent means null");
  const i = parseAsk("fyi: the fixture store moved");
  assert.equal(i.kind, "fyi");
  assert.equal(i.recommend, null);
});

test("a non-decision may still volunteer a Recommend:, and it is split out not buried", () => {
  // One grammar, not two — a follow-up that has advice should not hide it inside its text.
  const f = parseAsk("follow-up: the retry path needs a task. Recommend: do it before the v3 cut");
  assert.equal(f.text, "the retry path needs a task.");
  assert.equal(f.recommend, "do it before the v3 cut");
});

test("the kind prefix is case-insensitive and tolerates loose spacing", () => {
  assert.equal(parseAsk("FYI : the store moved").kind, "fyi");
  assert.equal(parseAsk("Follow-Up: write the task").kind, "follow-up");
});

test("a colon in the body does not split the ask a second time", () => {
  const a = parseAsk("fyi: the error reads: cannot find module");
  assert.equal(a.kind, "fyi");
  assert.equal(a.text, "the error reads: cannot find module");
});

// ── parseAsks over a whole list ──

test("parseAsks returns the good ones and one error per bad one, dropping nothing silently", () => {
  const { asks, errors } = parseAsks([
    "decision: v2 or v3? Recommend: v3, the id should say the shape",
    "todo: x",
    "follow-up: write the retry task",
    "fyi:",
  ]);
  assert.deepEqual(asks.map((a) => a.kind), ["decision", "follow-up"]);
  assert.equal(errors.length, 2, "every unparseable entry must be reported, not dropped");
});

test("an absent or empty asks field is no asks and no errors", () => {
  for (const input of [undefined, null, []]) {
    assert.deepEqual(parseAsks(input), { asks: [], errors: [] },
      "every task written before this field must read as 'nothing to ask'");
  }
});

test("parseAsks reports a non-list and a non-string entry instead of throwing", () => {
  assert.equal(parseAsks("decision: x").asks.length, 0);
  assert.match(parseAsks("decision: x").errors[0], /must be a list of strings/);
  const { asks, errors } = parseAsks([{ kind: "decision" }, 7, "fyi: fine"]);
  assert.deepEqual(asks.map((a) => a.text), ["fine"]);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e, /is not a string/);
});

// ── criterion 6: this module must stay loadable in a browser ──
// A mechanical source scan, not a judgment call. inflight is a page with no bundler, so one
// `node:` import here is the difference between reusing this grammar and re-implementing it in a
// `<script>` block where it drifts. The failure is also invisible in Node, which is why the gate
// cannot be "the tests pass" — they would.

test("criterion 6: asks.mjs imports nothing from node: and uses no Node-only global", () => {
  const src = readFileSync(new URL("./asks.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /["']node:/,
    "asks.mjs must not reference a node: specifier — inflight loads this file in a browser");
  assert.doesNotMatch(src, /\bfrom\s+["']/,
    "asks.mjs must import nothing at all: a relative import drags its own dependencies in too");
  for (const global of ["process", "require", "__dirname", "Buffer"]) {
    assert.doesNotMatch(src, new RegExp(`\\b${global}\\b`),
      `asks.mjs must not use the Node-only global \`${global}\``);
  }
});

// ── criterion 7: the three documents state the split ──
// Prose is what a worker actually follows — this module is only the enforcement. The protocol is
// authoritative; `project-template/CLAUDE.md` restates the split alone, deliberately (its
// maintainer notes say why), and these assertions are what stop the two copies drifting.

const TEMPLATE = new URL("../../", import.meta.url);        // project-template/
const docs = {
  "PROTOCOL.md": readFileSync(new URL(".flow/PROTOCOL.md", TEMPLATE), "utf8"),
  "CLAUDE.md": readFileSync(new URL("CLAUDE.md", TEMPLATE), "utf8"),
  "_TEMPLATE.md": readFileSync(new URL(".flow/tasks/_TEMPLATE.md", TEMPLATE), "utf8"),
};

test("criterion 7: each of the three documents states the notes/asks split", () => {
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, /\basks\b/, `${name} must mention asks`);
    assert.match(text, /next session|next SESSION|next \*\*session\*\*/,
      `${name} must say notes is for the next session`);
    assert.match(text, /human/i, `${name} must say asks is for the human`);
  }
});

test("criterion 7: each document names all three kinds with an example of each", () => {
  for (const [name, text] of Object.entries(docs)) {
    for (const kind of ASK_KINDS) {
      assert.ok(text.includes(`"${kind}: `) || text.includes(`- "${kind}:`) || text.includes(`${kind}: <`),
        `${name} must carry an example ask of kind ${kind}`);
    }
  }
});

test("criterion 7: each document states that a decision must carry Recommend:", () => {
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, /Recommend:/, `${name} must name the Recommend: clause`);
    assert.match(text, /decision/i, `${name} must tie it to the decision kind`);
  }
});

test("criterion 7: the examples the three documents carry actually parse", () => {
  // The cheapest way for documentation to lie is to teach a shape the parser rejects.
  let checked = 0;
  for (const [name, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/^\s*(?:#\s*)?-\s*"((?:decision|follow-up|fyi): [^"]+)"/gm)) {
      const r = parseAsk(m[1]);
      assert.equal(r.error, undefined, `${name} teaches an ask the parser rejects: ${m[1]}`);
      checked++;
    }
  }
  assert.ok(checked >= 9, `expected at least three examples in each of three documents, found ${checked}`);
});

// ── the changelog entry ──
// Canonical-only: `changes/` and CHANGELOG.md are not synced to adopting repos, so this skips
// visibly there. Read through `changelog-entry.mjs`, never `changes/<id>.md` directly — a release
// folds the fragment into CHANGELOG.md and deletes it, so a direct read is green until the
// release PR and red on it.
{
  const { existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const CANON = existsSync(join(root, ".flow", "bin", "changelog-entry.mjs")) ? root : null;

  test("flow-0119 has a changelog entry naming the asks field",
    { skip: CANON ? false : "canonical-only: `changes/` and CHANGELOG.md are not synced to adopting repos" },
    async () => {
      const { changelogEntry } = await import(pathToFileURL(join(CANON, ".flow", "bin", "changelog-entry.mjs")).href);
      const text = changelogEntry(CANON, "flow-0119");
      assert.ok(text, "flow-0119's changelog entry must exist, as a fragment or in CHANGELOG.md");
      assert.match(text, /asks/, "the entry must name the new field");
      assert.match(text, /caller action/i, "the entry must state whether a caller has to act");
    });
}
