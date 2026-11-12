import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabase } from "../revisit/database-fixture";
const fixture = disposableDatabase();
describe("app library real database boundaries", () => {
  beforeAll(async () => { await fixture.start(); }, 420000);
  afterAll(() => { fixture.stop(); });
  it("AC1/AC2/AC3/AC7 atomically exposes only owned returned rows, preserves recall rules, and pages 120 captures: 44 pgTAP outcomes", () => {
    const output = fixture.sql(readFileSync("supabase/tests/database/app_library.test.sql", "utf8"));
    expect(output).not.toContain("not ok");
    expect(output).toContain("1..44");
    expect(output.split("\n").filter(line => /^ok \d+ - /u.test(line))).toHaveLength(44);
  });
});
