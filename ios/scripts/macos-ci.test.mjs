// Runs macos-ci.sh on any machine with bash, against stubbed xcodebuild / xcrun / xcodegen, so
// the step ordering, the skip decision and the failure exits are proved on the Linux gate too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./macos-ci.sh", import.meta.url));

const SIMCTL = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "SIM-1", name: "iPhone 17", isAvailable: true }],
  },
};

function stub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(file, 0o755);
}

// One sandbox per test: stub tools on PATH, a fake Xcode.app, and a log of every tool call.
function sandbox({ failOn = "", coverage = { targets: [{ name: "Later.app", executableLines: 100, coveredLines: 60 }] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "macos-ci-"));
  const bin = join(root, "bin");
  const xcode = join(root, "Xcode.app");
  mkdirSync(bin);
  mkdirSync(join(xcode, "Contents", "Developer"), { recursive: true });
  writeFileSync(join(root, "simctl.json"), JSON.stringify(SIMCTL));
  writeFileSync(join(root, "coverage.json"), JSON.stringify(coverage));
  stub(bin, "xcodebuild", `[[ -n "$STUB_FAIL_ON" && " $* " == *" $STUB_FAIL_ON "* ]] && exit 65\nexit 0`);
  stub(bin, "xcodegen", `[[ "$STUB_FAIL_ON" == generate ]] && exit 1\nexit 0`);
  stub(
    bin,
    "xcrun",
    [
      `case "$*" in`,
      `  *--show-sdk-version*) echo 26.5 ;;`,
      `  simctl*) cat "${root}/simctl.json" ;;`,
      `  xccov*) cat "${root}/coverage.json" ;;`,
      `  *) exit 1 ;;`,
      `esac`,
    ].join("\n"),
  );
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_FAIL_ON: failOn,
    IOS_CI_XCODE_APP: xcode,
    IOS_CI_XCODEGEN: join(bin, "xcodegen"),
    IOS_CI_OUTPUT: join(root, "out"),
  };
  return { root, env, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

function run(env, extra = {}) {
  return spawnSync("bash", [SCRIPT], { env: { ...env, ...extra }, encoding: "utf8" });
}

function changed(root, paths) {
  const file = join(root, "changed.txt");
  writeFileSync(file, paths.join("\n"));
  return { IOS_CI_CHANGED_FILES: file };
}

test("skips when no iOS path changed", () => {
  const { root, env, calls } = sandbox();
  const r = run(env, changed(root, ["src/app/page.tsx", "README.md", ".github/workflows/flow-gates.yml", "iosx/a"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ios-ci: skipped/);
  assert.deepEqual(calls(), [], "no tool — xcodebuild included — may run on a skipped change");
});

test("runs when ios/ or the ios-ci workflow changed", () => {
  for (const path of ["ios/LaterApp/App/LaterApp.swift", ".github/workflows/ios-ci.yml"]) {
    const { root, env, calls } = sandbox();
    const r = run(env, changed(root, ["README.md", path]));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(calls().some((c) => c.startsWith("xcodebuild test-without-building")), path);
  }
});

test("generates, builds without signing, tests on the picked simulator, then checks coverage", () => {
  const { env, calls } = sandbox();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Later line coverage 60\.00% meets the floor of 40%/);
  const steps = calls().map((c) => c.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(steps, [
    "xcodebuild -version",
    "xcodegen generate",
    "xcrun --sdk",
    "xcrun simctl",
    "xcodebuild build-for-testing",
    "xcodebuild test-without-building",
    "xcrun xccov",
  ]);
  for (const call of calls().filter((c) => /^xcodebuild (build|test)/.test(c))) {
    assert.match(call, /CODE_SIGNING_ALLOWED=NO/);
    assert.match(call, /-destination platform=iOS Simulator,id=SIM-1/);
    assert.match(call, /-enableCodeCoverage YES/);
  }
});

for (const step of ["build-for-testing", "test-without-building"]) {
  test(`exits non-zero when xcodebuild ${step} fails`, () => {
    const { env, calls } = sandbox({ failOn: step });
    const r = run(env);
    assert.notEqual(r.status, 0);
    assert.ok(!calls().some((c) => c.startsWith("xcrun xccov")), "nothing runs after the failure");
  });
}

test("exits non-zero when project generation fails", () => {
  const { env, calls } = sandbox({ failOn: "generate" });
  assert.notEqual(run(env).status, 0);
  assert.ok(!calls().some((c) => c.startsWith("xcodebuild build")));
});

test("exits non-zero when app coverage is below the floor", () => {
  const { env } = sandbox({ coverage: { targets: [{ name: "Later.app", executableLines: 100, coveredLines: 10 }] } });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Later line coverage 10\.00% is below the floor of 40%/);
});

test("exits non-zero when the pinned Xcode is missing", () => {
  const { root, env, calls } = sandbox();
  const r = run(env, { IOS_CI_XCODE_APP: join(root, "Missing.app") });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Xcode 26\.6 not found/);
  assert.ok(!existsSync(join(root, "out", "Later.xcresult")));
  assert.deepEqual(calls(), []);
});
