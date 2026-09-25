import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").trim();
}

describe("Flow v2 lifecycle proof", () => {
  it("AC1 identifies later-0015 and the exact adopted Flow version", () => {
    expect(repositoryFile(".flow/VERSION")).toBe("2.0.0");
    expect(repositoryFile("FLOW_V2_PROOF.md")).toContain("later-0015");
    expect(repositoryFile("FLOW_V2_PROOF.md")).toContain("Flow 2.0.0");
  });
});
