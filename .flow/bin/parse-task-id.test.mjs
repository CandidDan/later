// Tests for parse-task-id — flow-status / flow-done grade their own id resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idFromBranch, idFromTitle, parseTaskId } from "./parse-task-id.mjs";

// ── parseTaskId: branch wins ──

test("branch flow/<id>-slug resolves to the id even with an empty title", () => {
  assert.equal(parseTaskId("flow/CAN-30-slug", ""), "CAN-30");
});

test("branch wins over the title when both carry an id", () => {
  // The branch is canonical; the title is only a fallback. They should never disagree, but
  // if they do, the branch is the source of truth.
  assert.equal(parseTaskId("flow/CAN-30-slug", "[CAN-99] something else"), "CAN-30");
});

test("a flow/<id> branch with no slug still resolves", () => {
  assert.equal(parseTaskId("flow/CAN-30", ""), "CAN-30");
});

// ── parseTaskId: title fallback ──

test("non-conforming branch falls back to a leading [<id>] in the PR title", () => {
  assert.equal(
    parseTaskId("claude/blissful-edison-3srhxo", "[CAN-43] Build Today's Meetings"),
    "CAN-43",
  );
});

test("title fallback works when the branch is empty/undefined", () => {
  assert.equal(parseTaskId(undefined, "[CAN-7] fix"), "CAN-7");
  assert.equal(parseTaskId("", "[CAN-7] fix"), "CAN-7");
});

// ── parseTaskId: neither source ──

test("returns null when neither branch nor title carries an id", () => {
  assert.equal(parseTaskId("claude/blissful-edison-3srhxo", "Random PR title"), null);
  assert.equal(parseTaskId("", ""), null);
  assert.equal(parseTaskId(undefined, undefined), null);
});

// ── idFromBranch ──

test("idFromBranch: only matches the flow/ convention", () => {
  assert.equal(idFromBranch("flow/CAN-12-a-longer-slug"), "CAN-12");
  assert.equal(idFromBranch("main"), null);
  assert.equal(idFromBranch("claude/keen-maxwell-y272ah"), null);
  assert.equal(idFromBranch("feature/CAN-12"), null); // not the flow/ prefix
});

test("idFromBranch: project-agnostic prefix (not hard-coded to CAN)", () => {
  assert.equal(idFromBranch("flow/PROJ-301-x"), "PROJ-301");
});

// ── idFromTitle ──

test("idFromTitle: only a LEADING [<id>] counts", () => {
  assert.equal(idFromTitle("[CAN-43] Build Today's Meetings"), "CAN-43");
  assert.equal(idFromTitle("  [CAN-43] leading whitespace ok"), "CAN-43");
  assert.equal(idFromTitle("Fixes [CAN-43] mid-sentence"), null);
  assert.equal(idFromTitle("no id here"), null);
});
