// intake-config.mjs — the ONE reader of the `intake:` block in `.flow/config.yml` (ADR-0010 §6).
//
// Three later checks read this block: label-actor verification (`trusted_labelers`), the size
// classifier (`classifier_model`) and the diff-size check (`trivial.max_changed_lines`). They all
// import `readIntakeConfig` from here, so the defaults are decided in exactly one place.
//
// EVERY DEFAULT IS THE RESTRICTIVE ONE, and every doubt resolves to it:
//   · trustedLabelers  → []        no `flow:trusted` label is believed from anyone. A missing
//                                  block, an empty value, a malformed list, or a list with even one
//                                  entry that is not a plain GitHub login all read as []. Dropping
//                                  only the bad entry would be guessing what the author meant, and
//                                  this list is what opens a write-capable triage agent to public
//                                  text — so a list we cannot read whole is a list we do not trust.
//   · classifierModel  → "haiku"   returned as written otherwise. What an unknown tier means is the
//                                  classifier's call (it fails closed to `normal`), not this parser's.
//   · maxChangedLines  → 20        additions + deletions. Anything but a positive whole number reads
//                                  as 20 — never as 0 ("nothing is trivial" is not what a typo means)
//                                  and never as unbounded.
//
// House style: a tolerant line scan, no YAML dependency — the same approach as `parseQueueCap` in
// allocate-task-id.mjs. Only keys that sit under the TOP-LEVEL `intake:` key are read, so a
// `trusted_labelers:` under `review:` or anywhere else is never mistaken for this list.

export const INTAKE_DEFAULTS = Object.freeze({
  trustedLabelers: Object.freeze([]),
  classifierModel: "haiku",
  maxChangedLines: 20,
});

// A GitHub login (alphanumerics and single inner hyphens, at most 39 characters), optionally an
// App's `<slug>[bot]`. Deliberately excludes `*`, whitespace and the empty string.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

const indentOf = (line) => line.match(/^ */)[0].length;
const isSkippable = (line) => /^\s*(#.*)?$/.test(line);
const stripComment = (v) => v.replace(/(^|\s+)#.*$/, "").trim();
const unquote = (v) => v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
const scalar = (v) => unquote(stripComment(v));

// The lines of the top-level `intake:` block (its children only), or [] when there is none.
function intakeBlock(lines) {
  const start = lines.findIndex((l) => /^intake:\s*(#.*)?$/.test(l));
  if (start === -1) return [];
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!isSkippable(lines[i]) && indentOf(lines[i]) === 0) break;
    body.push(lines[i]);
  }
  return body;
}

// Direct children of a block: `key → { value, index }`, where `index` points into `body` so a
// caller can read the nested lines that follow. The child indent is the first real line's.
function children(body) {
  const out = new Map();
  const first = body.find((l) => !isSkippable(l));
  if (first === undefined) return out;
  const level = indentOf(first);
  body.forEach((line, index) => {
    if (isSkippable(line) || indentOf(line) !== level) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/);
    if (m && !out.has(m[1])) out.set(m[1], { value: m[2] ?? "", index });
  });
  return out;
}

// The nested lines under the child at `index`: every following line indented deeper than it.
function nested(body, index) {
  const level = indentOf(body[index]);
  const out = [];
  for (let i = index + 1; i < body.length; i++) {
    if (!isSkippable(body[i]) && indentOf(body[i]) <= level) break;
    out.push(body[i]);
  }
  return out;
}

// Validated logins, or [] for anything not wholly readable.
function parseLogins(value, following) {
  const v = stripComment(value);
  let items;
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) return [];
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    items = inner.split(",").map((s) => unquote(s.trim()));
  } else if (v === "") {
    items = [];
    for (const line of following) {
      if (isSkippable(line)) continue;
      const m = line.match(/^\s*-\s+(.*)$/) ?? line.match(/^\s*-()$/);
      if (!m) return []; // a nested line that is not a list item: not a list we can read
      items.push(scalar(m[1]));
    }
  } else {
    return []; // a bare scalar is not a list
  }
  return items.every((s) => LOGIN.test(s)) ? items : [];
}

function parseMaxChangedLines(value) {
  const v = scalar(value);
  if (!/^\d+$/.test(v)) return INTAKE_DEFAULTS.maxChangedLines;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : INTAKE_DEFAULTS.maxChangedLines;
}

/**
 * Read the `intake:` block from the text of a `.flow/config.yml`.
 * Never throws; anything missing or unreadable takes its restrictive default.
 * @param {string} configText
 * @returns {{ trustedLabelers: string[], classifierModel: string, maxChangedLines: number }}
 */
export function readIntakeConfig(configText) {
  const lines = String(configText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const body = intakeBlock(lines);
  const keys = children(body);

  const trusted = keys.get("trusted_labelers");
  const trustedLabelers = trusted ? parseLogins(trusted.value, nested(body, trusted.index)) : [];

  const model = keys.get("classifier_model");
  const classifierModel = (model && scalar(model.value)) || INTAKE_DEFAULTS.classifierModel;

  let maxChangedLines = INTAKE_DEFAULTS.maxChangedLines;
  const trivial = keys.get("trivial");
  if (trivial && stripComment(trivial.value) === "") {
    const max = children(nested(body, trivial.index)).get("max_changed_lines");
    if (max) maxChangedLines = parseMaxChangedLines(max.value);
  }

  return { trustedLabelers, classifierModel, maxChangedLines };
}
