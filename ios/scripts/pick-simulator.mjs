#!/usr/bin/env node
// pick-simulator.mjs — choose an iPhone simulator from what this machine actually has.
//
//   xcrun simctl list devices available --json | node ios/scripts/pick-simulator.mjs --max-version 26.5
//
// Prints the chosen device's UDID on stdout (and what it chose on stderr). Hosted macOS images
// change their simulator set with every Xcode, so a hard-coded "iPhone 16" breaks the build the
// day it disappears. Rule: the newest iOS runtime at or below the SDK version (and at or above the
// deployment target), then the first available iPhone on it by name.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIN_IOS = [18, 0]; // the deployment target in ios/Config/Base.xcconfig

// "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → [26, 5]; anything that is not iOS → null.
export function runtimeVersion(identifier) {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(identifier);
  return m ? m.slice(1).filter((p) => p !== undefined).map(Number) : null;
}

// "26.5" → [26, 5].
export function parseVersion(text) {
  const parts = String(text).trim().split(".").map(Number);
  if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not a version: "${text}"`);
  }
  return parts;
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Returns `{ udid, name, runtime }` or throws naming what was available. */
export function pickSimulator(simctl, { maxVersion } = {}) {
  const runtimes = Object.entries(simctl?.devices ?? {})
    .map(([id, devices]) => ({ id, version: runtimeVersion(id), devices }))
    .filter((r) => r.version && compareVersions(r.version, MIN_IOS) >= 0)
    .filter((r) => !maxVersion || compareVersions(r.version, maxVersion) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const runtime of runtimes) {
    const iphones = runtime.devices
      .filter((d) => d.isAvailable !== false && /^iPhone\b/.test(d.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (iphones.length) {
      return { udid: iphones[0].udid, name: iphones[0].name, runtime: runtime.version.join(".") };
    }
  }
  const seen = Object.keys(simctl?.devices ?? {}).join(", ") || "none";
  throw new Error(`no available iPhone simulator on iOS ${MIN_IOS.join(".")}+ (runtimes: ${seen})`);
}

export function main(argv, input) {
  const i = argv.indexOf("--max-version");
  try {
    const maxVersion = i >= 0 ? parseVersion(argv[i + 1]) : undefined;
    const choice = pickSimulator(JSON.parse(input), { maxVersion });
    console.error(`pick-simulator: ${choice.name} (iOS ${choice.runtime}) ${choice.udid}`);
    console.log(choice.udid);
    return 0;
  } catch (err) {
    console.error(`pick-simulator: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), readFileSync(0, "utf8"));
}
