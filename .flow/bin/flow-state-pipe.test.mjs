// flow-state-pipe.test.mjs — node --test. Proves the flow-state CLI delivers its whole output
// when stdout is a pipe (flow-0212).
//
// The bug: the CLI ended with `process.exit(runStateCli(...))`. When stdout is a pipe, Node
// writes to it asynchronously, and `process.exit()` ends the process before those writes finish.
// A reader got the first 65,536 bytes (one pipe buffer) and nothing more, so `--json` output
// larger than that did not parse. The fix sets `process.exitCode` instead, so Node drains stdout
// before it exits.
//
// These tests run the real CLI file as a child process. Calling `runStateCli` in-process would
// write to a test sink, not a pipe, and could never show the bug. The CLI resolves its store from
// its own location (`.flow/bin` -> repo), so each test copies the template's `.flow/bin/` into a
// temp repo and builds the store there. That keeps the test independent of how big any real
// store is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binDir = dirname(fileURLToPath(import.meta.url));
const PIPE_BUFFER = 65536;

// A temp repo holding a copy of the template's helpers (not their tests) in `.flow/bin/`.
// `cliSource` replaces flow-state.mjs, for the before-and-after exit-code comparison.
function repoWithCli(cliSource) {
  const dir = mkdtempSync(join(tmpdir(), "flow-state-pipe-"));
  const bin = join(dir, ".flow", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of readdirSync(binDir)) {
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) copyFileSync(join(binDir, name), join(bin, name));
  }
  if (cliSource !== undefined) writeFileSync(join(bin, "flow-state.mjs"), cliSource);
  return dir;
}

// Writes `count` tasks into the repo's store. It is not a git repo, so flow-state reads the
// working tree, which is enough to exercise the CLI's output path.
function writeStore(dir, count) {
  const tasks = join(dir, ".flow", "tasks");
  mkdirSync(tasks, { recursive: true });
  const padding = "a long title that makes each row of the report bigger ".repeat(4);
  for (let i = 1; i <= count; i++) {
    const id = `CAN-${String(i).padStart(4, "0")}`;
    writeFileSync(join(tasks, `${id}.md`),
      `---\nid: "${id}"\ntitle: "${id} ${padding}"\nstatus: "ready"\npriority: 2\nowner: ""\n` +
      `branch: ""\npr: ""\nblocked_reason: ""\nissue: ""\n---\nbody\n`);
  }
}

// Runs the copied CLI with stdout as a pipe to this process, which is how any reader sees it.
const runCli = (dir, args) =>
  spawnSync(process.execPath, [join(dir, ".flow", "bin", "flow-state.mjs"), ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

test("flow-0212: a piped --json run larger than 64 KB arrives whole and parses (criterion 1)", () => {
  const dir = repoWithCli();
  try {
    const count = 600;
    writeStore(dir, count);
    const r = runCli(dir, ["--json", "--no-pr"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 2 * PIPE_BUFFER,
      `the fixture must exceed the pipe buffer by a clear margin; got ${r.stdout.length} bytes`);
    assert.ok(r.stdout.endsWith("}\n"), "the output must end where the JSON ends, not mid-row");
    const report = JSON.parse(r.stdout);
    assert.equal(report.tasks.length, count, "every task in the store must be in the output");
    assert.equal(report.tasks.at(-1).id, `CAN-${String(count).padStart(4, "0")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flow-0212: the CLI sets the exit code rather than calling process.exit", () => {
  // The structural half of criterion 1: a later edit back to `process.exit(runStateCli(...))`
  // would bring the truncation back on any platform where pipe writes are asynchronous.
  const src = readFileSync(join(binDir, "flow-state.mjs"), "utf8");
  assert.match(src, /process\.exitCode = runStateCli\(/);
  assert.doesNotMatch(src, /process\.exit\(runStateCli\(/);
});

test("flow-0212: exit codes are the same as before the change (criterion 3)", () => {
  // The CLI exactly as it was before flow-0212, rebuilt from the current file.
  const current = readFileSync(join(binDir, "flow-state.mjs"), "utf8");
  const before = current.replace(/process\.exitCode = (runStateCli\([^;]*\));/, "process.exit($1);");
  assert.notEqual(before, current, "the old CLI line must have been rebuilt for the comparison");

  // Each case: [label, prepare the repo, args, expected exit code].
  const cases = [
    ["an unknown flag is ignored, as before", (d) => writeStore(d, 2), ["--json", "--no-pr", "--no-such-flag"], 0],
    ["a store path that is a file, not a directory, crashes", (d) => writeFileSync(join(d, ".flow", "tasks"), "not a dir"), ["--json", "--no-pr"], 1],
  ];
  for (const [label, prepare, args, expected] of cases) {
    const statuses = [undefined, before].map((source) => {
      const dir = repoWithCli(source);
      try { prepare(dir); return runCli(dir, args).status; }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
    assert.deepEqual(statuses, [expected, expected], `${label}: [after, before] exit codes`);
  }
});
