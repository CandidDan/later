#!/usr/bin/env node
// check-coverage.mjs — fail the iOS build when line coverage drops below a floor.
//
//   node ios/scripts/check-coverage.mjs llvm-cov LaterKit <swift test --show-codecov-path>
//   node ios/scripts/check-coverage.mjs xccov    Later    <xcrun xccov view --report --json>
//
// The floors live here, not in CI config, so they travel with the code they measure. They may
// only be raised: a floor lowered to make a red build green proves nothing.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FLOORS = Object.freeze({
  LaterKit: 80, // lines, LaterKit package sources (Linux, llvm-cov export)
  Later: 40, // lines, the Later app target (macOS, xccov report)
});

export const FORMATS = Object.freeze(["llvm-cov", "xccov"]);

// llvm-cov export (what `swift test --enable-code-coverage` writes). The export covers every file
// the test binary touched — test sources and generated anchors included — so only files under
// the package's `Sources/<target>/` count; counting the tests would flatter the number.
export function measureLlvmCov(report, target) {
  if (report?.type !== "llvm.coverage.json.export" || !Array.isArray(report.data)) {
    throw new Error("not an llvm-cov export (expected type llvm.coverage.json.export)");
  }
  const marker = `/Sources/${target}/`;
  let count = 0;
  let covered = 0;
  for (const file of report.data.flatMap((d) => d.files ?? [])) {
    if (!String(file.filename).includes(marker)) continue;
    count += file.summary.lines.count;
    covered += file.summary.lines.covered;
  }
  if (count === 0) throw new Error(`no ${target} source files in the llvm-cov export`);
  return (covered / count) * 100;
}

// xccov report (`xcrun xccov view --report --json`). An app target is listed as `<name>.app`.
export function measureXccov(report, target) {
  if (!Array.isArray(report?.targets)) {
    throw new Error("not an xccov report (expected a targets array)");
  }
  const found = report.targets.find((t) => t.name === `${target}.app` || t.name === target);
  if (!found) {
    const names = report.targets.map((t) => t.name).join(", ") || "none";
    throw new Error(`no ${target} target in the xccov report (targets: ${names})`);
  }
  if (!found.executableLines) throw new Error(`${target} has no executable lines in the report`);
  return (found.coveredLines / found.executableLines) * 100;
}

const MEASURE = { "llvm-cov": measureLlvmCov, xccov: measureXccov };

/** Returns `{ ok, message }`; never throws for a bad report — that is a failure too. */
export function checkCoverage({ format, target, report }) {
  if (!FORMATS.includes(format)) {
    return { ok: false, message: `coverage: unknown format "${format}" (use ${FORMATS.join(" or ")})` };
  }
  const floor = FLOORS[target];
  if (floor === undefined) {
    return { ok: false, message: `coverage: no floor for target "${target}" (known: ${Object.keys(FLOORS).join(", ")})` };
  }
  let percent;
  try {
    percent = MEASURE[format](report, target);
  } catch (err) {
    return { ok: false, message: `coverage: ${target}: ${err.message}` };
  }
  const shown = `${percent.toFixed(2)}%`;
  if (percent < floor) {
    return { ok: false, message: `coverage: ${target} line coverage ${shown} is below the floor of ${floor}%` };
  }
  return { ok: true, message: `coverage: ${target} line coverage ${shown} meets the floor of ${floor}%` };
}

export function main(argv) {
  const [format, target, file] = argv;
  if (!format || !target || !file) {
    console.error("usage: check-coverage.mjs <llvm-cov|xccov> <target> <report.json>");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`coverage: ${target}: cannot read ${file}: ${err.message}`);
    return 1;
  }
  const { ok, message } = checkCoverage({ format, target, report });
  (ok ? console.log : console.error)(message);
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
