// Tests for flow-sync — the adopt mechanism's pure brain (version decision + PR text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, syncBranch, prContent } from "./flow-sync.mjs";

// ── decide ──

test("behind: local strictly older than canonical → sync", () => {
  assert.equal(decide("1.0.0", "1.2.0"), "behind");
  assert.equal(decide("1.0.0", "2.0.0"), "behind");
  assert.equal(decide("1.1.9", "1.2.0"), "behind");
});

test("current: equal versions → nothing to do", () => {
  assert.equal(decide("1.2.0", "1.2.0"), "current");
});

test("current: short/long and v-prefixed forms compare equal (tag v1 vs stamp 1.0.0)", () => {
  // The canonical tag is `v1` while the VERSION stamp is `1.0.0`; compareVersions pads and
  // strips the prefix, so these must not read as drift.
  assert.equal(decide("1.0.0", "v1"), "current");
  assert.equal(decide("1", "1.0.0"), "current");
});

test("ahead: repo newer than canonical → never sync backwards", () => {
  assert.equal(decide("1.3.0", "1.2.0"), "ahead");
  assert.equal(decide("2.0.0", "v1"), "ahead");
});

test("behind: a missing/empty local stamp adopts the stamp + infra", () => {
  assert.equal(decide("", "1.0.0"), "behind");
  assert.equal(decide(undefined, "1.0.0"), "behind");
});

test("decide throws when canonical version is absent", () => {
  assert.throws(() => decide("1.0.0", ""), /canonical version is required/);
});

// ── syncBranch ──

test("syncBranch is stable per target version (idempotent reuse)", () => {
  assert.equal(syncBranch("1.2.0"), "flow-sync/1.2.0");
  assert.equal(syncBranch("1.2.0"), syncBranch("1.2.0"));
});

// ── prContent ──

test("prContent: title names the target version", () => {
  assert.equal(prContent({ local: "1.0.0", canonical: "1.2.0" }).title,
    "flow: adopt canonical Flow infra 1.2.0");
});

test("prContent: body lists each changed file and the version transition", () => {
  const { body } = prContent({
    local: "1.0.0", canonical: "1.2.0",
    files: [".flow/bin/flow-doctor.mjs", ".flow/VERSION"],
  });
  assert.match(body, /`1\.0\.0` → `1\.2\.0`/);
  assert.match(body, /- `\.flow\/bin\/flow-doctor\.mjs`/);
  assert.match(body, /- `\.flow\/VERSION`/);
});

test("prContent: empty file list is reported as version-stamp-only, not a blank section", () => {
  const { body } = prContent({ local: "1.0.0", canonical: "1.2.0", files: [] });
  assert.match(body, /version stamp only/);
});

test("prContent: a missing local stamp renders as (none) in the transition", () => {
  const { body } = prContent({ local: "", canonical: "1.0.0" });
  assert.match(body, /`\(none\)` → `1\.0\.0`/);
});
