// later-0022 — reviewer models come from canonical Flow, never from this repo's config.
// A pin here goes stale silently when canonical moves to a new model (DEFAULT_MODELS in
// .flow/bin/flow-review.mjs decides). Line-based read of the `review:` block: no YAML parser here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reviewBlock = (text: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^review:\s*$/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
};

describe("later-0022 reviewer models come from canonical", () => {
  it("review: sets none of model, code_review_model, security_model", () => {
    const block = reviewBlock(readFileSync(".flow/config.yml", "utf8"));
    expect(block).not.toBe("");
    for (const key of ["model", "code_review_model", "security_model"]) {
      expect(block, `review.${key} is set in .flow/config.yml`).not.toMatch(new RegExp(`^\\s+${key}:`, "m"));
    }
  });
});
