import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").trim();
}

describe("Flow v2 lifecycle proof", () => {
  // The proof records the version it ran on (Flow 2.0.0) in FLOW_V2_PROOF.md. It must not pin the
  // LIVE .flow/VERSION, or every Flow upgrade fails this test (the 3.1.0 sync did).
  it("AC1 identifies later-0015 and the exact adopted Flow version", () => {
    expect(repositoryFile("FLOW_V2_PROOF.md")).toContain("later-0015");
    expect(repositoryFile("FLOW_V2_PROOF.md")).toContain("Flow 2.0.0");
  });
});
