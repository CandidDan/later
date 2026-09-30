import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("later-0017 research console operator documentation", () => {
  it("AC6 names the Supabase site URL, research redirect and pre-existing evaluator requirement", () => {
    const readme = readFileSync("README.md", "utf8");
    const authSection = readme.slice(
      readme.indexOf("## 2. Create and migrate the production Supabase project"),
      readme.indexOf("## 3. Configure and deploy Vercel for `notfor.now`"),
    );

    expect(authSection).toContain("Site URL");
    expect(authSection).toContain("https://notfor.now");
    expect(authSection).toContain("https://notfor.now/research");
    expect(authSection).toContain("must already exist");
    expect(authSection).toContain("RESEARCH_USER_ID");
    expect(authSection).toContain("does not create an account");
  });
});
