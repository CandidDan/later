import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disposableDatabase } from "../../revisit/database-fixture";

const fixture = disposableDatabase();
const PLAN = 31;

describe("article extraction real database boundaries", () => {
  beforeAll(async () => { await fixture.start(); }, 420000);
  afterAll(() => { fixture.stop(); });

  it(`AC1/AC2/AC5/AC6/AC7 enqueue, not_an_article, retries, exposure-gated RLS and immutability: ${PLAN} pgTAP outcomes`, () => {
    const output = fixture.sql(readFileSync("supabase/tests/database/article_extraction.test.sql", "utf8"));
    expect(output).not.toContain("not ok");
    expect(output).toContain(`1..${PLAN}`);
    expect(output.split("\n").filter((line) => /^ok \d+ - /u.test(line))).toHaveLength(PLAN);
  });
});
