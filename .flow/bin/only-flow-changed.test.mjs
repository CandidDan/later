// only-flow-changed.test.mjs — proving tests for flow-0122. Throwaway git repos in a temp dir.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { decide, parseArgs, pickBase, runCli } from "./only-flow-changed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "only-flow-changed.mjs");
const REPO = resolve(HERE, "..", "..", "..");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "ofc-"));
  g(d, "init", "-q", "-b", "main");
  write(d, "README.md", "x");
  g(d, "add", "-A"); g(d, "commit", "-qm", "root");
  return d;
}
function write(d, rel, body = "y") {
  mkdirSync(dirname(join(d, rel)), { recursive: true });
  writeFileSync(join(d, rel), body + Math.random());
}
function commit(d, ...files) {
  for (const f of files) write(d, f);
  g(d, "add", "-A"); g(d, "commit", "-qm", files.join(","));
  return g(d, "rev-parse", "HEAD");
}
const cli = (cwd, args = [], env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: "", CACHED_COMMIT_REF: "", ...env },
  });
  return { code: r.status, out: r.stdout.trim() };
};

test("only .flow/ and changes/ changed -> exit 0, stdout starts with skip", () => {
  const d = repo(); const base = g(d, "rev-parse", "HEAD");
  commit(d, ".flow/tasks/x.md", "changes/flow-1.md", ".github/workflows/a.yml");
  const r = cli(d, ["--base", base]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^only-flow-changed: skip/);
  assert.equal(r.out.split("\n").length, 1);
});

test("code and task change together -> build; code then task-only commit with base before both -> build", () => {
  const d = repo(); const base = g(d, "rev-parse", "HEAD");
  commit(d, "app/page.js", ".flow/tasks/x.md");
  assert.equal(cli(d, ["--base", base]).code, 1);
  const d2 = repo(); const base2 = g(d2, "rev-parse", "HEAD");
  commit(d2, "app/page.js"); commit(d2, ".flow/tasks/x.md");
  const r = cli(d2, ["--base", base2]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^only-flow-changed: build/);
  // the parent-only diff would have skipped: the tip really is task-only
  assert.equal(cli(d2).code, 0);
});

test("shallow clone missing the base -> build, says base not in checkout", () => {
  const d = repo(); const base = g(d, "rev-parse", "HEAD");
  for (let i = 0; i < 4; i++) commit(d, `a${i}.js`);
  const s = mkdtempSync(join(tmpdir(), "ofc-sh-"));
  g(s, "clone", "-q", "--depth", "1", pathToFileURL(d).href, "c");
  const r = cli(join(s, "c"), ["--base", base]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not in checkout/);
});

test("base precedence: --base, VERCEL_GIT_PREVIOUS_SHA, CACHED_COMMIT_REF, HEAD^", () => {
  assert.equal(pickBase({ base: "a" }, { VERCEL_GIT_PREVIOUS_SHA: "b" }).sha, "a");
  assert.equal(pickBase({ base: "" }, { VERCEL_GIT_PREVIOUS_SHA: "b", CACHED_COMMIT_REF: "c" }).sha, "b");
  assert.equal(pickBase({ base: "" }, { CACHED_COMMIT_REF: "c" }).sha, "c");
  assert.equal(pickBase({ base: "" }, {}).sha, "HEAD^");
  const d = repo(); const base = g(d, "rev-parse", "HEAD");
  commit(d, "app/x.js"); commit(d, ".flow/t.md");
  assert.equal(cli(d, [], { VERCEL_GIT_PREVIOUS_SHA: base }).code, 1);
  assert.equal(cli(d, [], { CACHED_COMMIT_REF: base }).code, 1);
  assert.equal(cli(d).code, 0); // HEAD^ is the task-only commit's parent
});

test("root commit with no HEAD^ -> build", () => {
  const d = repo();
  const r = cli(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /no parent/);
});

test("scope: web/ cwd with ../supabase/functions; flow paths resolve from the repo top", () => {
  const d = repo(); const base = g(d, "rev-parse", "HEAD");
  const web = join(d, "web"); mkdirSync(web);
  const args = ["--base", base, "../supabase/functions"];
  commit(d, "supabase/functions/f.ts");
  assert.equal(cli(web, args).code, 1);
  const d2 = repo(); const b2 = g(d2, "rev-parse", "HEAD"); mkdirSync(join(d2, "web"));
  commit(d2, "api/a.js");
  const r = cli(join(d2, "web"), ["--base", b2, "../supabase/functions"]);
  assert.equal(r.code, 0);
  const d3 = repo(); const b3 = g(d3, "rev-parse", "HEAD"); mkdirSync(join(d3, "web"));
  commit(d3, ".flow/tasks/t.md");
  assert.equal(cli(join(d3, "web"), ["--base", b3, "--", "../supabase/functions"]).code, 0);
  // a web/ change is in scope and is not Flow-only, even next to a .flow one
  const d4 = repo(); const b4 = g(d4, "rev-parse", "HEAD"); mkdirSync(join(d4, "web"));
  commit(d4, "web/p.js", ".flow/t.md");
  assert.equal(cli(join(d4, "web"), ["--base", b4]).code, 1);
});

test("no error path exits 0", () => {
  const outside = mkdtempSync(join(tmpdir(), "ofc-out-"));
  const d = repo();
  commit(d, ".flow/t.md");
  const cases = [
    ["outside any repo", () => cli(outside, ["--base", "HEAD"])],
    ["unknown flag", () => cli(d, ["--nope"])],
    ["--base without value", () => cli(d, ["--base"])],
    ["--base= empty", () => cli(d, ["--base="])],
    ["--base looks like a flag", () => cli(d, ["--base", "--help"])],
    ["pathspec magic extra", () => cli(d, [":(top)x"])],
    ["unknown base", () => cli(d, ["--base", "deadbeefdeadbeef"])],
    ["env base is a flag", () => cli(d, [], { VERCEL_GIT_PREVIOUS_SHA: "--output=/tmp/x" })],
    ["git not runnable", () => cli(d, ["--base", "HEAD^"], { PATH: "/nonexistent" })],
  ];
  for (const [name, fn] of cases) {
    const r = fn();
    assert.equal(r.code, 1, name);
    assert.match(r.out, /^only-flow-changed: build/, name);
  }
});

test("forced git failure (injected) builds, never skips; thrown errors build", () => {
  const ok = (a) => (a[0] === "rev-parse" ? "" : "");
  assert.equal(decide({ argv: [], git: ok }).skip, true);
  for (const failAt of ["--is-inside-work-tree", "--verify", "diff"]) {
    const git = (a) => { if (a.includes(failAt)) throw new Error("boom"); return ""; };
    assert.equal(decide({ argv: ["--base", "abc1234"], git }).skip, false, failAt);
  }
  const out = [];
  assert.equal(runCli(["--base", "x"], { git: () => { throw new Error("x"); }, out: (s) => out.push(s) }), 1);
  assert.match(out[0], /build/);
  assert.equal(decide({ argv: ["--base", "x"], git: () => { throw null; } }).skip, false);
  assert.deepEqual(parseArgs(["--base=abc", "p", "--", "-q"]), { base: "abc", extra: ["p", "-q"] });
});

test("the canonical adapter imports the template module and holds no decision logic", (t) => {
  if (!existsSync(join(REPO, ".flow", "bin", "only-flow-changed.mjs"))) return t.skip("not canonical");
  const src = readFileSync(join(REPO, ".flow", "bin", "only-flow-changed.mjs"), "utf8");
  assert.match(src, /project-template\/\.flow\/bin\/only-flow-changed\.mjs/);
  assert.doesNotMatch(src, /execFileSync|child_process|"diff"/);
  const r = spawnSync(process.execPath, [join(REPO, ".flow", "bin", "only-flow-changed.mjs"), "--nope"],
    { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^only-flow-changed: build/);
});

test("PROTOCOL.md carries the rule", () => {
  const p = readFileSync(join(HERE, "..", "PROTOCOL.md"), "utf8");
  assert.match(p, /\.flow\/bin\/only-flow-changed\.mjs/);
  assert.match(p, /any doubt builds/i);
});
