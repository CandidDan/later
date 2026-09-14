import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ResearchPage, { metadata } from "./page";

describe("research page", () => {
  it("AC1 renders no capture, analysis or evaluation data to an unauthenticated visitor", () => {
    const markup = renderToStaticMarkup(<ResearchPage />);

    // Everything on screen arrives later from the authenticated API, so the page itself is
    // an empty shell — there is nothing here for an unauthenticated visitor to read.
    expect(markup).toContain("Evaluate one capture");
    expect(markup).not.toMatch(
      /data-testid="capture-context"|data-phase="recall"|data-phase="reveal"|claude-|confidence/u,
    );
  });

  it("AC7 is excluded from indexing and presents no archive or backlog", () => {
    const markup = renderToStaticMarkup(<ResearchPage />);

    // Experiment tooling, not a consumption surface: it is not something to be found.
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(markup.replace(/<[^>]*>/gu, " ")).not.toMatch(
      /queue|backlog|archive|library|recommend|remaining/iu,
    );
  });
});
