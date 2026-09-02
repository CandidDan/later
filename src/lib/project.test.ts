import { describe, expect, it } from "vitest";

import { project } from "./project";

describe("project identity", () => {
  it("keeps the registered domain paired with the product promise", () => {
    expect(project).toEqual({
      name: "Later",
      domain: "notfor.now",
      promise: "Not for now. Saved for Later.",
    });
  });
});
