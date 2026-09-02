// allocate-task-id.test.mjs — proving tests for the pure allocator and the git transaction
// (flow-0021: "Make task-id allocation first-push-wins, so two orchestrators cannot land the
// same id"). The pure tests are ordinary unit tests; the transaction tests build REAL local git
// remotes (a bare repo, one or more clones) rather than mocking git, so a claim of "this push is
// really refused" or "these five allocators really raced" is proved by git's own semantics, not
// by a fake standing in for them.

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  AllocationError,
  SLUG_RE,
  allocateTaskId,
  assertInsideTasksDir,
  buildContentFromFile,
  idWidth,
  nextId,
  readIdsFromOrigin,
  runCli,
} from "./allocate-task-id.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, "allocate-task-id.mjs");

// ══ pure: idWidth / nextId ══════════════════════════════════════════════════════════════════

test("nextId: a full run of flow-0001..flow-0020 allocates flow-0021, zero-padded to width 4", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `flow-${String(i + 1).padStart(4, "0")}`);
  assert.equal(nextId(ids, "flow"), "flow-0021");
});

test("nextId: a gap (0001-0005, then 0009) allocates the successor to the MAXIMUM, never the gap", () => {
  const ids = ["flow-0001", "flow-0002", "flow-0003", "flow-0004", "flow-0005", "flow-0009"];
  assert.equal(nextId(ids, "flow"), "flow-0010");
});

test("nextId: an empty store allocates <prefix>-0001", () => {
  assert.equal(nextId([], "flow"), "flow-0001");
  assert.equal(nextId([], "acme"), "acme-0001");
});

test("nextId: ignores ids from a different prefix entirely", () => {
  assert.equal(nextId(["other-0099", "flow-0003"], "flow"), "flow-0004");
});

test("idWidth: derived from the widest id present, not assumed", () => {
  assert.equal(idWidth(["flow-001", "flow-002"], "flow"), 3);
  assert.equal(idWidth([], "flow"), 4);
});

// ══ fixtures: a real bare repo + real clone(s) — no git mocking ════════════════════════════

const tmpRoot = (name) => mkdtempSync(join(tmpdir(), `flow-alloc-${name}-`));
const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function taskFile(id) {
  return `---\nid: "${id}"\nstatus: "ready"\npriority: 3\ntouches: []\n---\n\nfixture\n`;
}

// A bare "remote", seeded with `seedIds` on `main`, plus one real clone (`work`) of it. Every
// git call in these tests is a real `git` invocation — there is nothing here for a fake to get
// subtly wrong.
function buildRemoteAndClone(seedIds) {
  const root = tmpRoot("remote");
  const bare = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);

  const seed = join(root, "seed");
  mkdirSync(join(seed, ".flow", "tasks"), { recursive: true });
  for (const id of seedIds) writeFileSync(join(seed, ".flow", "tasks", `${id}-seed.md`), taskFile(id));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  sh(seed, "config", "user.email", "t@t");
  sh(seed, "config", "user.name", "t");
  sh(seed, "add", "-A");
  sh(seed, "commit", "--quiet", "-m", "seed");
  sh(seed, "remote", "add", "origin", bare);
  sh(seed, "push", "--quiet", "origin", "main");

  const work = join(root, "work");
  execFileSync("git", ["clone", "--quiet", bare, work]);
  sh(work, "config", "user.email", "t@t");
  sh(work, "config", "user.name", "t");

  return { root, bare, work };
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

const trivial = { filenameFor: (id) => `${id}-x.md`, buildContent: (id) => taskFile(id) };

// ══ readIdsFromOrigin / the transaction ignore the working tree ═══════════════════════════

test("readIdsFromOrigin reads origin/main only — an uncommitted working-tree task file is invisible to it", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001", "flow-0002", "flow-0003"]);
  try {
    // A task file that exists ONLY in the working tree (never committed, never pushed) — the
    // exact shape of "two sessions, one has local drift the other never sees."
    writeFileSync(join(work, ".flow", "tasks", "flow-9999-rogue.md"), taskFile("flow-9999"));

    const ids = readIdsFromOrigin(work).sort();
    assert.deepEqual(ids, ["flow-0001", "flow-0002", "flow-0003"],
      "the rogue working-tree-only file must never reach the allocation path");
    assert.equal(nextId(ids, "flow"), "flow-0004",
      "allocating against it would have jumped to flow-0005/flow-10000, not flow-0004");
  } finally { cleanup(root); }
});

test("readIdsFromOrigin refuses rather than silently falling back to the working tree", () => {
  const dir = tmpRoot("no-origin");
  try {
    // Not a git repo at all — readTasksFromOrigin's own fallback would read the (empty)
    // working tree and report success. That fallback is right for a status report and wrong
    // here, so this must throw instead.
    assert.throws(() => readIdsFromOrigin(dir), AllocationError);
  } finally { cleanup(dir); }
});

// ══ the transaction: single allocator, real push ═══════════════════════════════════════════

test("allocateTaskId fetches, allocates, writes, commits and pushes — landing on the first attempt", () => {
  const { root, bare, work } = buildRemoteAndClone(["flow-0001", "flow-0002"]);
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", ...trivial });
    assert.equal(result.id, "flow-0003");
    assert.equal(result.attempts, 1);
    assert.ok(existsSync(result.path));

    const onRemote = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" });
    assert.match(onRemote, /flow-0003-x\.md/, "the commit must have actually reached the remote");
  } finally { cleanup(root); }
});

test("--dry-run allocates nothing: no file, no commit, no push", () => {
  const { root, bare, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", dryRun: true, ...trivial });
    assert.equal(result.id, "flow-0002");
    assert.equal(result.path, null);
    assert.equal(sh(work, "status", "--porcelain").trim(), "", "dry-run must leave the working tree clean");
    const log = execFileSync("git", ["--git-dir", bare, "log", "--oneline", "main"], { encoding: "utf8" });
    assert.equal(log.split("\n").filter(Boolean).length, 1, "dry-run must not have pushed a commit");
  } finally { cleanup(root); }
});

// ══ the retry path: a real refused push, forcing a real re-allocation ══════════════════════

test("a push refused by a real rival commit re-fetches, allocates a DIFFERENT id, renames, and retries", () => {
  const { root, bare, work } = buildRemoteAndClone(["flow-0001", "flow-0002"]);
  try {
    // What flow-0021's task file first computed, on a fetch taken BEFORE the rival lands.
    const firstComputed = nextId(readIdsFromOrigin(work), "flow");
    assert.equal(firstComputed, "flow-0003");

    let pushAttempts = 0;
    const git = (args) => {
      if (args[0] === "push") {
        pushAttempts++;
        if (pushAttempts === 1) {
          // Land a real rival commit on the bare remote BETWEEN our fetch and our push —
          // exactly the race the task exists to close. A second, independent clone does this,
          // so it is a genuine concurrent writer, not a hand-rolled failure.
          const rival = join(root, "rival");
          execFileSync("git", ["clone", "--quiet", bare, rival]);
          sh(rival, "config", "user.email", "t@t");
          sh(rival, "config", "user.name", "t");
          writeFileSync(join(rival, ".flow", "tasks", "flow-0003-rival.md"), taskFile("flow-0003"));
          sh(rival, "add", "-A");
          sh(rival, "commit", "--quiet", "-m", "rival lands first");
          sh(rival, "push", "--quiet", "origin", "main");
        }
      }
      return execFileSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };

    const result = allocateTaskId({ repoRoot: work, prefix: "flow", git, ...trivial });

    assert.equal(result.attempts, 2, "the first push must have been refused, forcing exactly one retry");
    assert.notEqual(result.id, firstComputed, "the id that finally lands must not be the id first computed");
    assert.equal(result.id, "flow-0004", "with the rival occupying flow-0003, the retry must allocate flow-0004");

    const onRemote = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" });
    assert.match(onRemote, /flow-0003-rival\.md/);
    assert.match(onRemote, /flow-0004-x\.md/);
    assert.doesNotMatch(onRemote, /flow-0003-x\.md/, "the stale first-attempt filename must not survive");
  } finally { cleanup(root); }
});

// ══ retry exhaustion: injected IO, no real git needed to prove the bookkeeping ═════════════

test("exhausting the retry budget throws, names the attempt count, and leaves no commit or file behind", () => {
  const commits = [];
  const resets = [];
  let writes = 0;
  let removed = null;

  const git = (args) => {
    if (args[0] === "commit") commits.push(args);
    if (args[0] === "reset") resets.push(args);
    if (args[0] === "push") throw new Error("refused (simulated)");
    return "";
  };

  assert.throws(
    () => allocateTaskId({
      repoRoot: "/fixture/root",
      prefix: "flow",
      maxAttempts: 3,
      readIds: () => ["flow-0001"],
      git,
      write: () => { writes++; },
      rename: () => {},
      remove: (p) => { removed = p; },
      filenameFor: (id) => `${id}-x.md`,
      buildContent: (id) => taskFile(id),
    }),
    (err) => {
      assert.ok(err instanceof AllocationError);
      assert.match(err.message, /exhausted 3 attempt/);
      return true;
    },
  );

  assert.equal(writes, 3, "every attempt must have tried to write its file");
  assert.equal(commits.length, 3, "every attempt must have committed before attempting to push");
  assert.equal(resets.length, 3, "every failed push must have been unwound — no commit left behind");
  assert.ok(removed, "the leftover working-tree file must be cleaned up on exhaustion");
});

// ══ source inspection: the retry path never reaches for pull/rebase/merge/force-push ═══════

test("no git call in the source invokes pull, rebase, merge, or a force-push", () => {
  const src = readFileSync(MODULE_PATH, "utf8");
  const gitCallArgs = [...src.matchAll(/\bgit\(\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(gitCallArgs.length >= 4, "expected several git([...]) call sites to inspect");

  const forbidden = /\bpull\b|\brebase\b|\bmerge\b|--force\b|(^|[[,]\s*)"-f"/;
  for (const call of gitCallArgs) {
    assert.doesNotMatch(call, forbidden, `forbidden git verb in a call site: git([${call}])`);
  }
});

// ══ five allocators, one shared remote, real OS-level concurrency ══════════════════════════
// "The concurrency test IS the deliverable" (flow-0021's notes) — this is not a stand-in for a
// real race, it runs five real `node` processes against five real clones of one bare repo, so
// the only thing making any of them wait is git's own non-fast-forward refusal.

test("five allocators racing a shared remote all land, with five distinct ids and no duplicate", async () => {
  const { root, bare } = buildRemoteAndClone(["flow-0001"]);
  try {
    const N = 5;
    const clones = [];
    for (let i = 0; i < N; i++) {
      const dir = join(root, `clone-${i}`);
      execFileSync("git", ["clone", "--quiet", bare, dir]);
      sh(dir, "config", "user.email", "t@t");
      sh(dir, "config", "user.name", "t");
      const contentFile = join(root, `content-${i}.md`);
      writeFileSync(contentFile, taskFile("PENDING"));
      clones.push({ dir, contentFile, slug: `alloc-${i}` });
    }

    const runOne = ({ dir, contentFile, slug }) => new Promise((res, rej) => {
      const child = spawn(process.execPath, [
        MODULE_PATH, "--write", "--repo-root", dir, "--prefix", "flow",
        "--content-file", contentFile, "--slug", slug,
      ], { encoding: "utf8" });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => code === 0 ? res(out.trim()) : rej(new Error(`exit ${code}: ${err}`)));
    });

    const results = await Promise.all(clones.map(runOne));
    assert.equal(results.length, N);

    const onRemote = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" });
    const landedIds = [...onRemote.matchAll(/(flow-\d+)-alloc-\d+\.md/g)].map((m) => m[1]);

    assert.equal(landedIds.length, N, `expected ${N} allocator commits to land; got:\n${onRemote}`);
    assert.equal(new Set(landedIds).size, N, `every landed id must be distinct; got ${landedIds.join(", ")}`);
    for (const id of landedIds) assert.notEqual(id, "flow-0001", "no allocator may collide with the seed");
  } finally { cleanup(root); }
}, { timeout: 30000 });

// ══ the CLI shell ═══════════════════════════════════════════════════════════════════════════

test("buildContentFromFile replaces only the id: line, leaving the rest untouched", () => {
  const src = `---\nid: "PENDING"\nstatus: "ready"\n---\nbody\n`;
  const out = buildContentFromFile(src, "flow-0099");
  assert.match(out, /^id: "flow-0099"$/m);
  assert.match(out, /^status: "ready"$/m);
  assert.match(out, /^body$/m);
});

test("runCli --dry-run prints the id and exits 0 without --slug/--content-file", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001", "flow-0002"]);
  try {
    let printed = "";
    const code = runCli(["--dry-run", "--repo-root", work, "--prefix", "flow"],
      { log: (s) => { printed = s; }, logErr: () => {}, cwd: work });
    assert.equal(code, 0);
    assert.equal(printed, "flow-0003");
  } finally { cleanup(root); }
});

test("runCli refuses --write without --slug or --content-file, and exits non-zero", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    let err = "";
    const code = runCli(["--write", "--repo-root", work, "--prefix", "flow"],
      { log: () => {}, logErr: (s) => { err = s; }, cwd: work });
    assert.notEqual(code, 0);
    assert.match(err, /--slug/);
  } finally { cleanup(root); }
});

test("runCli prints usage and exits 1 when given neither --dry-run nor --write", () => {
  let printed = "";
  const code = runCli([], { log: (s) => { printed = s; }, logErr: () => {}, cwd: "." });
  assert.equal(code, 1);
  assert.match(printed, /allocate-task-id/);
});

// ══ the caller-supplied filename cannot escape the store ══════════════════════════════════
//
// Found by the security check on PR #27. `filenameFor`'s result was joined onto tasksDir with
// no validation, and `join()` NORMALISES `..` — so a slug of `../../../../tmp/evil` resolved to
// `<repo>/tmp/evil.md`. This transaction then `git add`s, commits and PUSHES that path to
// `main`, so an attacker-chosen slug was an arbitrary file write landed on the default branch
// with no PR and no review. Not reachable from untrusted input while the allocator stays
// unwired (flow-0021 ships it deliberately uncalled), which is exactly why it had to be closed
// BEFORE the wiring task drives `--slug` from a task title.
//
// Both layers are proved separately, because each covers a hole the other cannot:
// the regex cannot help a programmatic caller supplying its own `filenameFor`, and the
// containment check cannot name the offending CLI flag in its message.

test("assertInsideTasksDir refuses a filename whose `..` segments escape the store", () => {
  const tasks = "/repo/.flow/tasks";
  for (const escape of [
    "flow-0004-../../../../tmp/evil.md",     // the verified PR #27 payload
    "../outside.md",
    "../../.github/workflows/ci.yml",
  ]) {
    assert.throws(() => assertInsideTasksDir(tasks, join(tasks, escape)), AllocationError,
      `${escape} resolves outside the store and must never reach the write/commit/push`);
  }
  // The store is flat, so a nested path is wrong even though it does not escape.
  assert.throws(() => assertInsideTasksDir(tasks, join(tasks, "sub/dir.md")), AllocationError);
  assert.throws(() => assertInsideTasksDir(tasks, tasks), AllocationError, "the dir itself is not a task file");
});

test("assertInsideTasksDir passes a normal task filename through unchanged", () => {
  const tasks = "/repo/.flow/tasks";
  const ok = join(tasks, "flow-0022-a-real-task.md");
  assert.equal(assertInsideTasksDir(tasks, ok), ok);
});

test("allocateTaskId refuses a traversing filenameFor BEFORE it writes, commits or pushes", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    const calls = [];
    assert.throws(() => allocateTaskId({
      repoRoot: work,
      prefix: "flow",
      filenameFor: (id) => `${id}-../../../../tmp/evil.md`,
      buildContent: (id) => taskFile(id),
      git: (args) => { calls.push(args[0]); return ""; },
      write: () => { throw new Error("write must never be reached for an escaping path"); },
    }), AllocationError);

    // The guard's whole value is its position: nothing may have been staged or pushed.
    assert.deepEqual(calls.filter((c) => ["add", "commit", "push"].includes(c)), [],
      "an escaping path must be refused before anything is staged, committed or pushed");
    assert.ok(!existsSync("/tmp/evil.md"), "nothing may be written outside the store");
  } finally { cleanup(root); }
});

test("runCli rejects a --slug carrying traversal, and never starts the transaction", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    const contentFile = join(work, "draft.md");
    writeFileSync(contentFile, "# draft\n");
    for (const slug of ["../../../../tmp/evil", "../escape", "a/b", "dot.md", "UPPER", "has space"]) {
      let err = "";
      const code = runCli(
        ["--write", "--repo-root", work, "--prefix", "flow", "--content-file", contentFile, "--slug", slug],
        { log: () => {}, logErr: (s) => { err = s; }, cwd: work });
      assert.equal(code, 1, `${JSON.stringify(slug)} must be refused`);
      assert.match(err, /--slug must be lowercase alphanumeric/);
    }
  } finally { cleanup(root); }
});

test("runCli rejects a valueless --slug rather than filing it under the string \"true\"", () => {
  const { root, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    const contentFile = join(work, "draft.md");
    writeFileSync(contentFile, "# draft\n");
    let err = "";
    // `--slug --content-file x` parses slug as the boolean true; String(true) would match the
    // regex as "true", so the type check has to come first.
    const code = runCli(
      ["--write", "--repo-root", work, "--prefix", "flow", "--slug", "--content-file", contentFile],
      { log: () => {}, logErr: (s) => { err = s; }, cwd: work });
    assert.equal(code, 1);
    assert.match(err, /--slug/);
  } finally { cleanup(root); }
});

test("SLUG_RE accepts the slugs this store actually uses and nothing that could traverse", () => {
  for (const good of ["atomic-task-id-allocation", "flightdeck-state-aggregator", "my-new-task", "flow2"]) {
    assert.ok(SLUG_RE.test(good), `${good} is a real slug shape and must keep working`);
  }
  for (const bad of ["../x", "a/b", "a\\b", ".", "..", "x.md", "-lead", "trail-", "double--hyphen", "Upper", ""]) {
    assert.ok(!SLUG_RE.test(bad), `${JSON.stringify(bad)} must not be usable as a filename fragment`);
  }
});

// ══ the CLI surfaces an exhausted retry budget to a real caller ═══════════════════════════
//
// Found by the code-review check on PR #27. AC8 ("exits non-zero, names the attempt count,
// leaves no commit or file behind") was proved at the `allocateTaskId` boundary, but the path a
// real caller actually takes — `runCli`'s catch, which turns a thrown AllocationError into
// `logErr(...)` + `return 1` — had ZERO coverage: `npx c8` reported lines 279-281 uncovered.
// Every other runCli failure test returns 1 from an explicit guard BEFORE allocateTaskId is
// called, so none of them throws and none of them reaches the catch.
//
// The refusal here is a real one: a `pre-receive` hook on the bare remote rejects every push,
// so `git push` exits non-zero exactly as it does against a remote someone else just advanced.
// Nothing is stubbed — the same posture as the five-allocator race test above.
function rejectAllPushes(bare) {
  const hook = join(bare, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'rejected by fixture' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
}

test("runCli exits non-zero and names the attempt count when the retry budget is exhausted", () => {
  const { root, bare, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    rejectAllPushes(bare);
    const contentFile = join(work, "draft.md");
    writeFileSync(contentFile, "# draft\n");

    let err = "";
    let out = "";
    const code = runCli(
      ["--write", "--repo-root", work, "--prefix", "flow", "--content-file", contentFile,
       "--slug", "never-lands", "--max-attempts", "2"],
      { log: (s) => { out += s; }, logErr: (s) => { err += s; }, cwd: work });

    // The catch block's whole job: a thrown AllocationError becomes a non-zero CLI exit.
    assert.equal(code, 1, "an exhausted retry budget must fail the CLI, not fall through as success");
    assert.match(err, /exhausted 2 attempt\(s\)/,
      `the caller must be told how many attempts were made; got: ${err}`);
    assert.equal(out, "", "nothing may be reported as allocated when nothing landed");

    // "...and does not allocate anyway": no task file left behind, nothing on the remote.
    assert.deepEqual(
      readdirSync(join(work, ".flow", "tasks")).filter((n) => n.includes("never-lands")), [],
      "the attempt's file must be removed, not left in the working tree");
    assert.doesNotMatch(sh(bare, "log", "--oneline", "main"), /allocate flow-0002/,
      "a refused push must leave the remote untouched");
  } finally { cleanup(root); }
});

test("runCli reports a non-AllocationError through the same catch, still exiting non-zero", () => {
  // The catch has two arms; the second (a generic Error, prefixed rather than passed through)
  // is what a genuinely unexpected failure hits. An unreadable --content-file reaches it via
  // readFileSync, so the arm is proved without stubbing the module.
  const { root, work } = buildRemoteAndClone(["flow-0001"]);
  try {
    let err = "";
    const code = runCli(
      ["--write", "--repo-root", work, "--prefix", "flow",
       "--content-file", join(work, "definitely-absent.md"), "--slug", "ok-slug"],
      { log: () => {}, logErr: (s) => { err += s; }, cwd: work });

    assert.equal(code, 1);
    assert.match(err, /allocate-task-id: /,
      "an unexpected error must still be surfaced with the tool's name, not swallowed");
  } finally { cleanup(root); }
});
