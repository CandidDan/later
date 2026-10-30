import { test } from "node:test";
import assert from "node:assert/strict";
import { prNumber, prOfRecord, ignoreLine, readPrField, main } from "./pr-of-record.mjs";

const URL200 = "https://github.com/o/r/pull/200";

test("an OPEN PR of record and an event on a different PR -> foreign, naming the record", () => {
  assert.deepEqual(prOfRecord({ prField: `"${URL200}"`, recordState: "OPEN", eventPr: 205 }), { verdict: "foreign", record: 200 });
});

test("empty pr:, or a CLOSED / MERGED record -> no-record", () => {
  for (const [prField, recordState] of [["", "OPEN"], ['""', "OPEN"], [URL200, "CLOSED"], [URL200, "MERGED"], ["junk", "OPEN"]]) {
    assert.equal(prOfRecord({ prField, recordState, eventPr: 205 }).verdict, "no-record", `${prField} ${recordState}`);
  }
});

test("the event is on the PR pr: names -> record", () => {
  assert.equal(prOfRecord({ prField: URL200, recordState: "OPEN", eventPr: 200 }).verdict, "record");
  assert.equal(prOfRecord({ prField: URL200, recordState: "OPEN", eventPr: "200" }).verdict, "record");
});

test("prNumber reads URLs, #n and bare numbers", () => {
  assert.equal(prNumber(URL200), 200);
  assert.equal(prNumber("#7"), 7);
  assert.equal(prNumber("7"), 7);
  assert.equal(prNumber(""), null);
});

test("readPrField reads frontmatter only", () => {
  assert.equal(readPrField(`---\nid: "a"\npr: "${URL200}"\n---\npr: nope\n`), `"${URL200}"`);
  assert.equal(readPrField("---\nid: \"a\"\n---\npr: nope\n"), "");
});

test("ignoreLine has the documented shape", () => {
  assert.equal(ignoreLine({ event: "closed", eventPr: 9, id: "t-1", record: 200 }), "closed on PR #9 ignored: t-1's PR of record is #200 (open)");
});

const io = (pr, state) => ({ readMainTask: () => `---\nid: "t-1"\npr: "${pr}"\n---\n`, prState: () => state });

test("main: foreign exits 3 with the ignore line; --json always exits 0", () => {
  const r = main(["--id", "t-1", "--event-pr", "9", "--event", "closed"], io(URL200, "OPEN"));
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "closed on PR #9 ignored: t-1's PR of record is #200 (open)\n");
  const j = main(["--id", "t-1", "--event-pr", "0", "--json"], io(URL200, "OPEN"));
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.stdout), { verdict: "foreign", record: 200 });
});

test("main: record, no-record and unreadable all exit 0 silently", () => {
  assert.deepEqual(main(["--id", "t-1", "--event-pr", "200"], io(URL200, "OPEN")), { code: 0, stdout: "" });
  assert.deepEqual(main(["--id", "t-1", "--event-pr", "9"], io(URL200, "CLOSED")), { code: 0, stdout: "" });
  assert.deepEqual(main(["--id", "t-1", "--event-pr", "9"], { readMainTask() { throw new Error("no git"); } }), { code: 0, stdout: "" });
  assert.deepEqual(main([]), { code: 0, stdout: "" });
});
