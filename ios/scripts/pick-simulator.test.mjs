import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compareVersions, parseVersion, pickSimulator, runtimeVersion } from "./pick-simulator.mjs";

const SCRIPT = fileURLToPath(new URL("./pick-simulator.mjs", import.meta.url));
const RT = "com.apple.CoreSimulator.SimRuntime.";

const simctl = {
  devices: {
    [`${RT}iOS-17-5`]: [{ udid: "OLD", name: "iPhone 15", isAvailable: true }],
    [`${RT}iOS-26-2`]: [{ udid: "A262", name: "iPhone 17", isAvailable: true }],
    [`${RT}iOS-26-5`]: [
      { udid: "IPAD", name: "iPad (A16)", isAvailable: true },
      { udid: "PRO", name: "iPhone 17 Pro", isAvailable: true },
      { udid: "GONE", name: "iPhone 16", isAvailable: false },
      { udid: "BASE", name: "iPhone 17", isAvailable: true },
    ],
    [`${RT}watchOS-26-5`]: [{ udid: "WATCH", name: "Apple Watch", isAvailable: true }],
  },
};

test("parses runtime identifiers and versions", () => {
  assert.deepEqual(runtimeVersion(`${RT}iOS-26-5`), [26, 5]);
  assert.deepEqual(runtimeVersion(`${RT}iOS-18-3-1`), [18, 3, 1]);
  assert.equal(runtimeVersion(`${RT}watchOS-26-5`), null);
  assert.deepEqual(parseVersion("26.5\n"), [26, 5]);
  assert.throws(() => parseVersion("beta"), /not a version/);
  assert.equal(compareVersions([26, 5], [26, 5, 0]), 0);
  assert.ok(compareVersions([26, 2], [26, 5]) < 0);
});

test("picks the first available iPhone on the newest runtime", () => {
  assert.deepEqual(pickSimulator(simctl), { udid: "BASE", name: "iPhone 17", runtime: "26.5" });
});

test("never picks a runtime newer than the SDK", () => {
  assert.equal(pickSimulator(simctl, { maxVersion: [26, 4] }).udid, "A262");
});

test("ignores runtimes below the deployment target and fails when nothing fits", () => {
  assert.throws(
    () => pickSimulator({ devices: { [`${RT}iOS-17-5`]: simctl.devices[`${RT}iOS-17-5`] } }),
    /no available iPhone simulator on iOS 18\.0\+ \(runtimes: .*iOS-17-5\)/,
  );
  assert.throws(() => pickSimulator({}), /runtimes: none/);
});

test("the CLI prints the UDID, and exits non-zero on bad input", () => {
  const ok = spawnSync(process.execPath, [SCRIPT, "--max-version", "26.5"], {
    input: JSON.stringify(simctl),
    encoding: "utf8",
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "BASE");
  const bad = spawnSync(process.execPath, [SCRIPT], { input: "nope", encoding: "utf8" });
  assert.equal(bad.status, 1);
});
