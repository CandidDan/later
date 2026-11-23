// deployable-sha.test.mjs — proving tests for flow-0210. Throwaway git repos in a temp dir.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX, FLOW_PATHS, findDeployable, parseArgs, runCli } from "./deployable-sha.mjs";
import * as onlyFlowChanged from "./only-flow-changed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "deployable-sha.mjs");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "dsha-"));
  g(d, "init", "-q", "-b", "main");
  commit(d, "README.md");
  return d;
}
function commit(d, ...files) {
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), String(Math.random()));
  }
  g(d, "add", "-A"); g(d, "commit", "-q", "--allow-empty", "-m", files.join(",") || "empty");
  return g(d, "rev-parse", "HEAD");
}
const cli = (cwd, args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const TASK = ".flow/tasks/flow-0001-x.md";

test("code commit A, then Flow-only commit B: --head B prints A and exits 0", () => {
  const d = repo();
  const a = commit(d, "app/page.js");
  const b = commit(d, TASK);
  const r = cli(d, ["--head", b]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${a}\n`, "stdout is exactly one full sha");
  assert.match(r.err, /stepped over 1 Flow-only commit/);
});

test("a head that is itself a code commit is its own answer", () => {
  const d = repo();
  const a = commit(d, "app/page.js");
  const r = cli(d, ["--head", a]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${a}\n`);
  // A short sha or a ref resolves to the same full sha.
  assert.equal(cli(d, ["--head", a.slice(0, 7)]).out, `${a}\n`);
  assert.equal(cli(d, ["--head=main"]).out, `${a}\n`);
});

test("A (code), B (Flow), C (code), D (Flow, head): the answer is C, not A", () => {
  const d = repo();
  commit(d, "app/a.js");
  commit(d, TASK);
  const c = commit(d, "app/c.js");
  const head = commit(d, "changes/flow-0001.md", ".github/workflows/x.yml");
  const r = cli(d, ["--head", head]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${c}\n`);
});

test("more than --max Flow-only commits on top of the last code commit: exit 1, empty stdout", () => {
  const d = repo();
  const a = commit(d, "app/a.js");
  let head;
  for (let i = 0; i < 3; i++) head = commit(d, `.flow/tasks/t${i}.md`);
  const r = cli(d, ["--head", head, "--max", "3"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /no built commit within --max 3/);
  // One more commit allowed reaches A: --max counts the head itself.
  assert.equal(cli(d, ["--head", head, "--max", "4"]).out, `${a}\n`);
});

test("a shallow clone that lacks the needed history: exit 1, empty stdout, reason on stderr", () => {
  const d = repo();
  commit(d, "app/a.js");
  commit(d, TASK);
  const s = mkdtempSync(join(tmpdir(), "dsha-sh-"));
  g(s, "clone", "-q", "--depth", "1", pathToFileURL(d).href, "c");
  const c = join(s, "c");
  const r = cli(c, ["--head", "HEAD"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /shallow clone's history ends/);
});

test("an unknown sha: exit 1, empty stdout, reason on stderr", () => {
  const d = repo();
  const r = cli(d, ["--head", "0".repeat(40)]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /is not a commit in this clone/);
});

test("a missing --head: exit 1, empty stdout, reason on stderr", () => {
  const d = repo();
  const r = cli(d, []);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /--head <sha> is required/);
});

test("a commit that changes a Flow path and one other path is a code commit", () => {
  const d = repo();
  commit(d, "app/a.js");
  const mixed = commit(d, TASK, "app/b.js");
  const head = commit(d, TASK);
  assert.equal(cli(d, ["--head", head]).out, `${mixed}\n`);
});

test("the Flow-only list is only-flow-changed.mjs's FLOW_PATHS export, not a copy", () => {
  assert.equal(FLOW_PATHS, onlyFlowChanged.FLOW_PATHS, "the same array object, re-exported");
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /import \{ FLOW_PATHS, isFlowOnlyPath \} from "\.\/only-flow-changed\.mjs";/);
  assert.doesNotMatch(src, /"\.flow\/"|"changes\/"|"\.github\/"/, "no literal copy of the list");
  assert.equal(onlyFlowChanged.isFlowOnlyPath(".flow/tasks/x.md"), true);
  assert.equal(onlyFlowChanged.isFlowOnlyPath("src/.flow/x"), false, "anchored at the repo top");
});

test("refuses on every doubt: root commit, bad arguments, a failing git, a merge's first parent", () => {
  // A history that is Flow-only all the way to the root has no built commit to fall back to.
  const d = mkdtempSync(join(tmpdir(), "dsha-root-"));
  g(d, "init", "-q", "-b", "main");
  const root = commit(d, TASK);
  const r = cli(d, ["--head", root]);
  assert.equal(r.code, 1);
  assert.match(r.err, /root commit/);

  for (const argv of [["--head"], ["--head", "-x"], ["--head", "a", "--max", "0"],
    ["--head", "a", "--max", "1001"], ["--head", "a", "--max", "two"], ["--head", "a", "extra"],
    ["--max"]]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
    assert.equal(findDeployable({ argv, git: () => { throw new Error("no git expected"); } }).sha, "");
  }
  assert.equal(parseArgs(["--head", "a"]).max, DEFAULT_MAX);
  assert.equal(parseArgs(["--head=a", "--max=5"]).max, 5);

  // A git that fails mid-walk, and a git that answers nonsense, both refuse.
  const failing = (args) => {
    if (args[0] === "rev-parse" && args.includes("--verify")) return `${"a".repeat(40)}\n`;
    if (args[0] === "rev-parse") return "false\n";
    throw new Error("fatal: bad object");
  };
  assert.match(findDeployable({ argv: ["--head", "a"], git: failing }).why, /error: fatal: bad object/);
  assert.equal(findDeployable({ argv: ["--head", "a"], git: () => "not-a-sha\n" }).sha, "");

  // A merge commit is judged by its first-parent change: the merged code makes it a code commit.
  const m = repo();
  g(m, "checkout", "-q", "-b", "feature");
  commit(m, "app/feature.js");
  g(m, "checkout", "-q", "main");
  commit(m, TASK);
  g(m, "-c", "user.name=t", "merge", "-q", "--no-ff", "-m", "merge", "feature");
  const merge = g(m, "rev-parse", "HEAD");
  const head = commit(m, TASK);
  assert.equal(cli(m, ["--head", head]).out, `${merge}\n`);
});

test("an empty commit is stepped over, as the deploy hook skips it", () => {
  const d = repo();
  const a = commit(d, "app/a.js");
  const empty = commit(d);
  assert.equal(cli(d, ["--head", empty]).out, `${a}\n`);
});

test("runCli writes the sha to stdout only, and the reason to stderr", () => {
  const d = repo();
  const a = commit(d, "app/a.js");
  const out = []; const err = [];
  assert.equal(runCli(["--head", a], { cwd: d, out: (s) => out.push(s), err: (s) => err.push(s) }), 0);
  assert.deepEqual(out, [`${a}\n`]);
  assert.match(err.join(""), /head commit is itself a code commit/);
  out.length = 0; err.length = 0;
  assert.equal(runCli([], { cwd: d, out: (s) => out.push(s), err: (s) => err.push(s) }), 1);
  assert.deepEqual(out, []);
  assert.match(err.join(""), /^deployable-sha: refuse — /);
});
