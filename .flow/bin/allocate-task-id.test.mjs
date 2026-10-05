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
  URGENT_LABEL,
  allocateTaskId,
  assertInsideTasksDir,
  buildContentFromFile,
  idWidth,
  nextId,
  parseDraftFrontmatter,
  parseQueueCap,
  queueCapRefusal,
  queueCapReport,
  readIdsFromOrigin,
  readQueueCap,
  readStoreFromOrigin,
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
      readStore: () => ({ ids: ["flow-0001"], readyCount: 0 }),
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

// ══ the queue cap (flow-0070) ══════════════════════════════════════════════════════════════
//
// A WIP limit on the QUEUE, not on the work. The cap is enforced in the allocator rather than
// described in the task-writer skill, so these tests are the thing that makes it real — prose
// in a skill holds until the session that most wants to break it arrives.
//
// Every transaction test below uses the SAME real-remote fixtures as the rest of this file:
// `buildRemoteAndClone` seeds task files whose frontmatter says `status: "ready"`, so "8 ready
// on origin/main" is eight real committed files, counted by the same `readTasksFromOrigin` the
// allocator uses in production.

const readyIds = (n) => Array.from({ length: n }, (_, i) => `flow-${String(i + 1).padStart(4, "0")}`);

// A draft as the orchestrator would hand it to --content-file: `id:` still a placeholder,
// `status`/`labels` whatever is being proved.
function draftFile({ status = "ready", labels = null } = {}) {
  return `---\nid: "PENDING"\nstatus: "${status}"\npriority: 3\n` +
    (labels ? `labels: [${labels.join(", ")}]\n` : "") +
    `touches: []\n---\n\ndraft body\n`;
}
const draftOpts = (text) => ({
  filenameFor: (id) => `${id}-x.md`,
  buildContent: (id) => buildContentFromFile(text, id),
});

// ── pure: parseQueueCap ───────────────────────────────────────────────────────────────────

test("parseQueueCap reads a top-level integer and ignores a trailing comment or quotes", () => {
  assert.equal(parseQueueCap("coverage_min: 80\nqueue_cap: 8\ngit:\n"), 8);
  assert.equal(parseQueueCap("queue_cap: 8   # a WIP limit, see flow-0070\n"), 8);
  assert.equal(parseQueueCap('queue_cap: "12"\n'), 12);
  assert.equal(parseQueueCap("queue_cap: 0\n"), 0, "0 is a real cap — refuse every ready draft");
});

test("parseQueueCap returns null — never 0 — for absent, commented-out, nested or malformed", () => {
  for (const text of [
    "",
    "coverage_min: 80\n",
    "# queue_cap: 8\n",                       // the template's documented example
    "review:\n  queue_cap: 8\n",              // nested: only a TOP-LEVEL key is the cap
    "queue_cap:\n",
    "queue_cap: lots\n",
    "queue_cap: 8.5\n",
    "queue_cap: -1\n",
  ]) {
    assert.equal(parseQueueCap(text), null,
      `${JSON.stringify(text)} must read as uncapped, not as a cap of 0 that would freeze the queue`);
  }
});

test("readQueueCap reads the repo's own .flow/config.yml, and is null when there is no config", () => {
  const dir = tmpRoot("cap-config");
  try {
    assert.equal(readQueueCap(dir), null, "a repo with no .flow/config.yml is uncapped");
    mkdirSync(join(dir, ".flow"), { recursive: true });
    writeFileSync(join(dir, ".flow", "config.yml"), "project:\n  name: \"x\"\nqueue_cap: 8\n");
    assert.equal(readQueueCap(dir), 8);
  } finally { cleanup(dir); }
});

// ── pure: parseDraftFrontmatter ───────────────────────────────────────────────────────────

test("parseDraftFrontmatter reads status and labels in both YAML list forms", () => {
  assert.deepEqual(parseDraftFrontmatter(draftFile({ labels: ["queue", "urgent"] })),
    { status: "ready", labels: ["queue", "urgent"] });
  assert.deepEqual(parseDraftFrontmatter(draftFile({ status: "blocked" })),
    { status: "blocked", labels: [] });
  assert.deepEqual(
    parseDraftFrontmatter(`---\nid: "x"\nstatus: "ready"\nlabels:\n  - queue\n  - "urgent"\ntouches: []\n---\nbody\n`),
    { status: "ready", labels: ["queue", "urgent"] },
    "a block list is as valid as an inline one — a draft is hand-written");
  assert.deepEqual(parseDraftFrontmatter(`---\nid: "x"\nlabels: []\n---\n`), { status: "", labels: [] });
});

test("parseDraftFrontmatter reports no status for text that is not a frontmatter document", () => {
  // The CLI's --dry-run without a --content-file has no draft at all; an empty status is what
  // makes the cap inert there rather than refusing on a guess.
  for (const text of ["", "# just a heading\n", "---\nid: \"x\"\nstatus: \"ready\"\n"]) {
    assert.deepEqual(parseDraftFrontmatter(text), { status: "", labels: [] });
  }
});

// ── pure: the decision itself ─────────────────────────────────────────────────────────────

test("queueCapRefusal: 8 ready against a cap of 8 refuses a plain ready draft, naming count, cap and `urgent`", () => {
  const refusal = queueCapRefusal({ queueCap: 8, readyCount: 8, draftStatus: "ready", draftLabels: [] });
  assert.ok(refusal, "a cap of 8 is a MAXIMUM — the 9th ready task is refused");
  assert.match(refusal, /\b8 task\(s\) are `ready`/, "the message must name the current ready count");
  assert.match(refusal, /`queue_cap` is 8/, "the message must name the cap");
  assert.match(refusal, /urgent/, "the message must name the one bypass");
  assert.match(refusal, /blocked/, "the message must name the other way forward");
});

test("queueCapRefusal: every single condition that lifts the refusal", () => {
  const base = { queueCap: 8, readyCount: 8, draftStatus: "ready", draftLabels: [] };
  assert.equal(queueCapRefusal({ ...base, readyCount: 7 }), null, "under the cap, nothing changes");
  assert.equal(queueCapRefusal({ ...base, draftLabels: [URGENT_LABEL] }), null, "`urgent` is the bypass");
  assert.equal(queueCapRefusal({ ...base, draftStatus: "blocked" }), null,
    "the cap limits the READY queue, not the store");
  assert.equal(queueCapRefusal({ ...base, queueCap: null, readyCount: 50 }), null, "no cap, no refusal");
  assert.equal(queueCapRefusal({ ...base, queueCap: 8.5 }), null, "a non-integer cap is not a cap");
  assert.equal(queueCapRefusal(), null, "called with nothing at all, it refuses nothing");
  assert.ok(queueCapRefusal({ ...base, readyCount: 9 }), "over the cap refuses too, not only exactly at it");
  assert.ok(queueCapRefusal({ ...base, draftLabels: ["queue", "wip-limit"] }),
    "some other label is not the bypass");
});

test("queueCapReport says which of the three states it is in — including `off`", () => {
  assert.match(queueCapReport({ queueCap: 8, readyCount: 7, refusal: null }), /^queue_cap: ok — 7 ready/);
  assert.match(queueCapReport({ queueCap: null, readyCount: 13, refusal: null }), /^queue_cap: off —/);
  assert.match(queueCapReport({ queueCap: null, readyCount: 13, refusal: null }), /13 ready/);
  const refused = queueCapReport({ queueCap: 8, readyCount: 8, refusal: "x" });
  assert.match(refused, /^queue_cap: REFUSE — 8 ready on origin\/main, cap 8/);
  assert.match(refused, /urgent/);
  assert.match(refused, /blocked/);
  assert.match(refused, /Nothing was written/);
});

// ── readStoreFromOrigin counts `ready` from the same read that yields the ids ─────────────

test("readStoreFromOrigin returns the ids and the ready count from one read of origin/main", () => {
  const { root, work } = buildRemoteAndClone(readyIds(3));
  try {
    const { ids, readyCount } = readStoreFromOrigin(work);
    assert.equal(ids.length, 3);
    assert.equal(readyCount, 3, "the fixture's seeded task files are all `status: ready`");
  } finally { cleanup(root); }
});

// ── the transaction: AC1-AC6 ──────────────────────────────────────────────────────────────

test("cap 8, 8 ready, plain ready draft: AllocationError, and nothing is added, committed or pushed", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(8));
  try {
    const calls = [];
    const git = (args) => {
      calls.push(args[0]);
      return execFileSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };

    assert.throws(
      () => allocateTaskId({ repoRoot: work, prefix: "flow", queueCap: 8, git, ...draftOpts(draftFile()) }),
      (err) => {
        assert.ok(err instanceof AllocationError);
        assert.match(err.message, /8 task\(s\) are `ready`/);
        assert.match(err.message, /`queue_cap` is 8/);
        assert.match(err.message, /urgent/);
        return true;
      },
    );

    // The refusal's whole value is its position — before the write, like the traversal guard.
    assert.deepEqual(calls.filter((c) => ["add", "commit", "push"].includes(c)), [],
      "a capped draft must be refused before anything is staged, committed or pushed");
    assert.deepEqual(readdirSync(join(work, ".flow", "tasks")).filter((n) => n.endsWith("-x.md")), [],
      "no task file may be written");
    assert.equal(
      execFileSync("git", ["--git-dir", bare, "log", "--oneline", "main"], { encoding: "utf8" })
        .split("\n").filter(Boolean).length, 1,
      "the remote must still hold only the seed commit");
  } finally { cleanup(root); }
});

test("cap 8, 7 ready: the same draft is allocated exactly as it is today", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(7));
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", queueCap: 8, ...draftOpts(draftFile()) });
    assert.equal(result.id, "flow-0008");
    assert.equal(result.attempts, 1);
    const onRemote = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" });
    assert.match(onRemote, /flow-0008-x\.md/, "under the cap the transaction must land as normal");
  } finally { cleanup(root); }
});

test("cap 8, 8 ready, draft labelled `urgent`: allocated — the one bypass, and it is the human's", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(8));
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", queueCap: 8,
      ...draftOpts(draftFile({ labels: ["queue", URGENT_LABEL] })) });
    assert.equal(result.id, "flow-0009");
    assert.match(execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" }), /flow-0009-x\.md/);
  } finally { cleanup(root); }
});

test("cap 8, 8 ready, a `blocked` draft: allocated — the cap limits the ready queue, not the store", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(8));
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", queueCap: 8,
      ...draftOpts(draftFile({ status: "blocked" })) });
    assert.equal(result.id, "flow-0009");
    assert.match(execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" }), /flow-0009-x\.md/);
  } finally { cleanup(root); }
});

test("no cap at all, 50 ready: allocated — absent `queue_cap` is uncapped, which is the default", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(50));
  try {
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", ...draftOpts(draftFile()) });
    assert.equal(result.id, "flow-0051");
    assert.match(execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" }), /flow-0051-x\.md/);
  } finally { cleanup(root); }
}, { timeout: 60000 });

test("the count comes from origin/main only — uncommitted ready task files in the working tree are not counted", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(7));
  try {
    // Five more `ready` task files that exist ONLY in the working tree. Counted, they would put
    // the queue at 12 against a cap of 8 and refuse this draft; they must be invisible, for the
    // same reason the id is allocated against origin/main and not against local drift.
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(work, ".flow", "tasks", `flow-99${i}0-local.md`), taskFile(`flow-99${i}0`));
    }
    const result = allocateTaskId({ repoRoot: work, prefix: "flow", queueCap: 8, ...draftOpts(draftFile()) });
    assert.equal(result.id, "flow-0008", "the id, too, comes from origin/main and not the working tree");
    assert.match(execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main", ".flow/tasks"],
      { encoding: "utf8" }), /flow-0008-x\.md/);
  } finally { cleanup(root); }
});

// ── the CLI reads the cap from config and reports/refuses on it ───────────────────────────

function writeConfig(root, body) {
  mkdirSync(join(root, ".flow"), { recursive: true });
  writeFileSync(join(root, ".flow", "config.yml"), body);
}

test("runCli --write refuses on the cap in .flow/config.yml, exits non-zero and allocates nothing", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(8));
  try {
    writeConfig(work, "project:\n  name: \"flow\"\nqueue_cap: 8\n");
    const contentFile = join(work, "draft.md");
    writeFileSync(contentFile, draftFile());

    let err = "";
    let out = "";
    const code = runCli(
      ["--write", "--repo-root", work, "--prefix", "flow", "--content-file", contentFile, "--slug", "capped"],
      { log: (s) => { out += s; }, logErr: (s) => { err += s; }, cwd: work });

    assert.equal(code, 1, "a refused allocation must fail the CLI, not fall through as success");
    assert.match(err, /`queue_cap` is 8/);
    assert.match(err, /urgent/);
    assert.equal(out, "", "nothing may be reported as allocated when nothing landed");
    assert.deepEqual(readdirSync(join(work, ".flow", "tasks")).filter((n) => n.includes("capped")), []);
    assert.doesNotMatch(execFileSync("git", ["--git-dir", bare, "log", "--oneline", "main"], { encoding: "utf8" }),
      /allocate flow-0009/);
  } finally { cleanup(root); }
});

test("runCli --write lands the same draft once the config has no cap — the key is the only difference", () => {
  const { root, work } = buildRemoteAndClone(readyIds(8));
  try {
    writeConfig(work, "project:\n  name: \"flow\"\n# queue_cap: 8\n");
    const contentFile = join(work, "draft.md");
    writeFileSync(contentFile, draftFile());

    let out = "";
    const code = runCli(
      ["--write", "--repo-root", work, "--prefix", "flow", "--content-file", contentFile, "--slug", "uncapped"],
      { log: (s) => { out += s; }, logErr: () => {}, cwd: work });
    assert.equal(code, 0, out);
    assert.match(out, /^flow-0009 /);
  } finally { cleanup(root); }
});

test("runCli --dry-run with a --content-file reports the decision and still writes nothing", () => {
  const { root, bare, work } = buildRemoteAndClone(readyIds(8));
  try {
    writeConfig(work, "project:\n  name: \"flow\"\nqueue_cap: 8\n");
    const run = (text) => {
      const contentFile = join(work, "draft.md");
      writeFileSync(contentFile, text);
      const lines = [];
      const code = runCli(["--dry-run", "--repo-root", work, "--prefix", "flow", "--content-file", contentFile],
        { log: (s) => lines.push(s), logErr: () => {}, cwd: work });
      return { code, lines };
    };

    const refused = run(draftFile());
    assert.equal(refused.code, 0, "--dry-run reports; a non-zero exit would read as a real failure");
    assert.equal(refused.lines[0], "flow-0009", "line 1 stays the bare id every caller parses");
    assert.match(refused.lines[1], /^queue_cap: REFUSE — 8 ready on origin\/main, cap 8/);
    assert.match(refused.lines[1], /urgent/);

    const allowed = run(draftFile({ labels: [URGENT_LABEL] }));
    assert.match(allowed.lines[1], /^queue_cap: ok — 8 ready on origin\/main, cap 8/);

    assert.equal(sh(work, "status", "--porcelain", "--", ".flow/tasks").trim(), "",
      "--dry-run must leave the store exactly as it found it");
    assert.equal(
      execFileSync("git", ["--git-dir", bare, "log", "--oneline", "main"], { encoding: "utf8" })
        .split("\n").filter(Boolean).length, 1);
  } finally { cleanup(root); }
});

test("runCli --dry-run without a --content-file prints the bare id and no decision", () => {
  const { root, work } = buildRemoteAndClone(readyIds(8));
  try {
    writeConfig(work, "project:\n  name: \"flow\"\nqueue_cap: 8\n");
    const lines = [];
    const code = runCli(["--dry-run", "--repo-root", work, "--prefix", "flow"],
      { log: (s) => lines.push(s), logErr: () => {}, cwd: work });
    assert.equal(code, 0);
    assert.deepEqual(lines, ["flow-0009"],
      "with no draft there is nothing to judge — reporting a decision here would be reporting a guess");
  } finally { cleanup(root); }
});

// ── the skill says what the allocator enforces ────────────────────────────────────────────

test("the task-writer skill's cap paragraph names `queue_cap`, `urgent` and `blocked`", () => {
  // The skill sits at `.claude/skills/` next to `.flow/`, in the template and in every repo
  // that adopts it, so this relative path resolves in both.
  const skill = readFileSync(resolve(HERE, "..", "..", ".claude", "skills", "task-writer", "SKILL.md"), "utf8");
  const para = skill.split(/\n(?=\d+\.|##\s)/).find((p) => p.includes("queue_cap"));
  assert.ok(para, "the skill must have a paragraph about the cap at all");
  for (const word of ["queue_cap", "urgent", "blocked"]) {
    assert.match(para, new RegExp(word),
      `the cap paragraph must name \`${word}\` — a refused task is either not written yet, ` +
      "written blocked, or labelled urgent by the human, and an orchestrator that is not told " +
      "all three has only one move left: re-litigate the cap");
  }
});
