// asks.mjs — the grammar of a task's `asks:` field: one open item for the HUMAN.
//
// THE PROBLEM IT SOLVES. A worker ends a task by appending `notes` on `main`, and `notes` is a
// machine handoff: what is done, what only looks done, the exact next action. Workers also put
// things only a person can act on into those same notes — "FOR THE HUMAN OR ORCHESTRATOR", "a
// follow-up task is worth writing", "owner ruling between (a), (b), (c)". The human never opens
// task frontmatter, so those items reach nobody unless an orchestrator session happens to read
// and relay them. Prose in `notes` cannot be routed: nothing can tell "for the next worker" from
// "for you". `asks` is the routable half.
//
//   asks:
//     - "decision: v2 or v3 in the schema id? Recommend: v3, the id should say the shape"
//     - "follow-up: the retry path needs its own task, it is out of scope here"
//     - "fyi: the fixture store moved, so a stale checkout fails one test"
//
// FOUR DECISIONS, MADE ONCE (flow-0119), so nothing downstream has to relitigate them:
//
//   1. AN ASK IS A STRING, not a map. Every existing frontmatter reader in the fleet
//      (`flow-state`, `pick-task`, `flow-doctor`, the flightdeck's browser-safe parser) reads a
//      list of scalars already, via `parseListField`. A list of maps would need every one of
//      them changed in lockstep, in repos that pin different refs. The kind lives in a prefix
//      instead, and the grammar — not the YAML shape — carries the structure.
//
//   2. THIS FILE IS BROWSER-SAFE. It imports nothing, and uses only language built-ins
//      (`String`, `Array`, `Math.imul`) — no `node:` module, no Node-only global. inflight is a
//      page, and it must flag these items without re-implementing the grammar in a `<script>`
//      block where it would drift (the same rule `flightdeck/bin/mission-control.mjs` follows).
//      `asks.test.mjs` scans this source mechanically to keep it true.
//
//   3. THE ID IS A HASH OF THE ASK, NOT A COUNTER. A counter needs somewhere to live and some
//      authority to increment it; across runs, branches and repos there is no such place. A
//      short stable hash of the normalised text means the same ask is recognised wherever it is
//      read, by anything, with no shared state — which is what lets a consumer say "this is the
//      ask I already showed you" rather than posting it twice.
//
//   4. THE ID COVERS THE KIND AND THE QUESTION, NOT THE RECOMMENDATION. Rewording a
//      recommendation is a worker improving its own advice about the same open question, and an
//      id that changed there would read as a new ask every time. Rewording the question IS a new
//      ask, and the id says so.
//
// Resolving an ask REMOVES it from `asks` and appends a `notes` line recording the answer. That
// is the protocol's rule, not this file's: nothing here mutates a task.

/** The three kinds, in the order a human should be shown them: blocking first, informational last. */
export const ASK_KINDS = ["decision", "follow-up", "fyi"];

/**
 * The normalised form an id is computed over: whitespace collapsed, case folded, trimmed.
 *
 * Deliberately blunt. It absorbs the differences that are not differences — a re-wrapped YAML
 * line, a double space, a capitalised first word — and nothing else. It does NOT strip
 * punctuation or stem words: two genuinely different questions must never collide, and a human
 * who rewrites the question has asked a new thing.
 */
export function normaliseAskText(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// cyrb53 — a 53-bit non-cryptographic hash, chosen because it is sync, dependency-free and runs
// identically in both targets. `crypto.subtle.digest` is the obvious alternative and is wrong
// here twice over: it is async (so `parseAsk` would have to be too, infecting every caller) and
// `node:crypto`'s sync API is not a Web global. 53 bits is far more than this needs — the
// population is the open asks across one fleet, tens at a time, where collision risk is nil.
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A short stable id for `s` — same input, same id, on every call, in every runtime, forever.
 *
 * Fixed width (11 base-36 characters, zero-padded) so ids column-align in a report and a
 * truncated one is visibly truncated rather than plausibly short.
 */
export function askId(s) {
  return cyrb53(normaliseAskText(s)).toString(36).padStart(11, "0");
}

const SHAPE = 'each ask must read "<kind>: <text>", kind one of ' + ASK_KINDS.join(", ");

// The `Recommend:` clause, wherever it starts in the remainder of the ask. Case-insensitive and
// word-anchored, so `Recommend:`/`recommend:` both land and `Recommended:` does not open a clause
// by accident — but `recommendation:` would not either, and that is the point: one spelling.
const RECOMMEND = /\brecommend\s*:\s*([\s\S]*)$/i;

/**
 * Parse one ask. Returns `{ id, kind, text, recommend }` on success, or `{ error }` — never
 * throws, and never a partially-filled object, so a caller branches on `error` once.
 *
 * `recommend` is split off for ANY kind, not only `decision`: one grammar is easier to teach
 * than two, and a `follow-up` that volunteers a recommendation should not have it buried in the
 * text. Only `decision` REQUIRES one, because a decision that arrives without a recommendation
 * makes the human do the thinking the worker was already holding (G12).
 */
export function parseAsk(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return { error: `empty ask — ${SHAPE}` };

  const m = raw.match(/^([A-Za-z][A-Za-z-]*)\s*:\s*([\s\S]*)$/);
  if (!m) return { error: `ask "${raw}" has no kind prefix — ${SHAPE}` };

  const kind = m[1].toLowerCase();
  if (!ASK_KINDS.includes(kind)) return { error: `ask "${raw}" has unknown kind "${m[1]}" — ${SHAPE}` };

  const rest = m[2].trim();
  const rec = rest.match(RECOMMEND);
  const text = (rec ? rest.slice(0, rec.index) : rest).trim();
  const recommend = rec && rec[1].trim() ? rec[1].trim() : null;

  if (!text) return { error: `ask "${raw}" has empty text — ${SHAPE}` };
  if (kind === "decision" && !recommend)
    return { error: `decision ask "${raw}" carries no "Recommend: <option and why>" — ` +
      "a decision reaches the human with the recommendation the worker already holds, " +
      "or it hands back thinking that was already done" };

  // The id covers the kind and the question, never the recommendation — decision 4 above.
  return { id: askId(`${kind}: ${text}`), kind, text, recommend };
}

/**
 * Parse a whole `asks:` list — typically `parseListField(head, "asks")`, which yields strings,
 * but typed `unknown` because a YAML-parsing caller can hand over anything.
 *
 * Returns BOTH halves: `asks` (the ones that parsed) and `errors` (one sentence per entry that
 * did not). Never throws and never drops an entry silently — a malformed ask that vanished would
 * be an item for the human that no longer reaches anyone, which is the bug `asks` exists to fix.
 * An absent field is `{ asks: [], errors: [] }`, so every existing task reads as "nothing to ask".
 */
export function parseAsks(list) {
  const asks = [], errors = [];
  if (list === null || list === undefined) return { asks, errors };
  if (!Array.isArray(list)) return { asks, errors: [`asks must be a list of strings — ${SHAPE}`] };
  for (const entry of list) {
    if (typeof entry !== "string") {
      errors.push(`ask entry ${JSON.stringify(entry) ?? String(entry)} is not a string — ${SHAPE}`);
      continue;
    }
    const parsed = parseAsk(entry);
    if (parsed.error) errors.push(parsed.error);
    else asks.push(parsed);
  }
  return { asks, errors };
}
