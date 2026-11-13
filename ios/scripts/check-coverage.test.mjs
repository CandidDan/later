import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FLOORS, checkCoverage, measureLlvmCov, measureXccov } from "./check-coverage.mjs";

const SCRIPT = fileURLToPath(new URL("./check-coverage.mjs", import.meta.url));

function llvmCov(files) {
  return {
    type: "llvm.coverage.json.export",
    version: "3.0.1",
    data: [{ files: files.map(([filename, count, covered]) => ({ filename, summary: { lines: { count, covered } } })) }],
  };
}

function xccov(targets) {
  return { targets: targets.map(([name, executableLines, coveredLines]) => ({ name, executableLines, coveredLines })) };
}

function run(format, target, report) {
  const dir = mkdtempSync(join(tmpdir(), "check-coverage-"));
  const file = join(dir, "report.json");
  writeFileSync(file, typeof report === "string" ? report : JSON.stringify(report));
  return spawnSync(process.execPath, [SCRIPT, format, target, file], { encoding: "utf8" });
}

test("floors are LaterKit 80% and Later 40% lines", () => {
  assert.deepEqual({ ...FLOORS }, { LaterKit: 80, Later: 40, LaterShare: 40 });
});

test("llvm-cov counts only the package's Sources files", () => {
  const report = llvmCov([
    ["/r/ios/LaterKit/Sources/LaterKit/App/AppInfo.swift", 10, 5],
    ["/r/ios/LaterKit/Sources/LaterKit/Formatting/X.swift", 10, 10],
    ["/r/ios/LaterKit/Tests/LaterKitTests/AppInfoTests.swift", 100, 100],
    ["/r/ios/LaterKit/.build/DerivedSources/test_anchor.swift", 1, 1],
  ]);
  assert.equal(measureLlvmCov(report, "LaterKit"), 75);
});

test("xccov reads the app target listed as <name>.app", () => {
  const report = xccov([["LaterKit", 10, 10], ["Later.app", 200, 90], ["LaterAppTests.xctest", 50, 50]]);
  assert.equal(measureXccov(report, "Later"), 45);
});

test("below the floor exits non-zero naming the target and both numbers", () => {
  const r = run("llvm-cov", "LaterKit", llvmCov([["/x/Sources/LaterKit/A.swift", 1000, 799]]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LaterKit line coverage 79\.90% is below the floor of 80%/);

  const app = run("xccov", "Later", xccov([["Later.app", 100, 39]]));
  assert.equal(app.status, 1);
  assert.match(app.stderr, /Later line coverage 39\.00% is below the floor of 40%/);
});

test("at or above the floor exits zero", () => {
  const atFloor = run("llvm-cov", "LaterKit", llvmCov([["/x/Sources/LaterKit/A.swift", 10, 8]]));
  assert.equal(atFloor.status, 0, atFloor.stderr);
  assert.match(atFloor.stdout, /LaterKit line coverage 80\.00% meets the floor of 80%/);

  const above = run("xccov", "Later", xccov([["Later.app", 100, 41]]));
  assert.equal(above.status, 0, above.stderr);
});

test("a report missing the target, of the wrong shape or unreadable fails", () => {
  assert.equal(checkCoverage({ format: "xccov", target: "Later", report: xccov([["Other.app", 1, 1]]) }).ok, false);
  assert.match(
    checkCoverage({ format: "llvm-cov", target: "LaterKit", report: llvmCov([["/x/Tests/A.swift", 1, 1]]) }).message,
    /no LaterKit source files/,
  );
  assert.match(checkCoverage({ format: "llvm-cov", target: "LaterKit", report: {} }).message, /not an llvm-cov export/);
  assert.match(checkCoverage({ format: "xccov", target: "Later", report: {} }).message, /not an xccov report/);
  assert.match(
    checkCoverage({ format: "xccov", target: "Later", report: xccov([["Later.app", 0, 0]]) }).message,
    /no executable lines/,
  );
  assert.equal(run("xccov", "Later", "{not json").status, 1);
});

test("an unknown format, target or missing argument fails", () => {
  assert.match(checkCoverage({ format: "lcov", target: "Later", report: {} }).message, /unknown format/);
  assert.match(checkCoverage({ format: "xccov", target: "Nope", report: {} }).message, /no floor for target "Nope"/);
  const r = spawnSync(process.execPath, [SCRIPT, "xccov"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

function shareReport(coveredLines = 50) {
  const files = readdirSync(new URL("../LaterShare/", import.meta.url))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => ({ path: `/r/ios/LaterShare/${name}`, executableLines: 100, coveredLines }));
  files.push({ path: "/r/ios/LaterShareTests/Test.swift", executableLines: 10000, coveredLines: 10000 });
  return { targets: [{ name: "LaterShareTests.xctest", files }] };
}

test("extension coverage excludes test bodies and enforces the 40 percent floor", () => {
  assert.equal(measureXccov(shareReport(), "LaterShare"), 50);
  assert.equal(run("xccov", "LaterShare", shareReport(39)).status, 1);
  assert.equal(run("xccov", "LaterShare", shareReport(40)).status, 0);
});

test("extension coverage fails closed for absent, duplicate or invalid production files", () => {
  for (const mutation of [
    (r) => r.targets[0].files.shift(),
    (r) => r.targets[0].files.push(r.targets[0].files[0]),
    (r) => { r.targets[0].files[0].coveredLines = 101; },
    (r) => { r.targets[0].files[0].executableLines = "100"; },
  ]) {
    const report = shareReport();
    mutation(report);
    assert.equal(checkCoverage({ format: "xccov", target: "LaterShare", report }).ok, false);
  }
  assert.equal(checkCoverage({ format: "xccov", target: "LaterShare", report: { targets: [] } }).ok, false);
});
