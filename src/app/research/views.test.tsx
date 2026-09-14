import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CaptureContext, RevealedRun } from "../../lib/research/types";

import { CapturePanel, EmptyPanel, ErrorPanel, RecallPanel, RevealPanel } from "./views";

const capture: CaptureContext = {
  captureId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  channel: "whatsapp",
  captureKind: "url",
  rawText: "https://example.test/pasta",
  userNote: "for sunday",
  sourcePlatform: null,
  capturedAt: "2026-09-01T10:00:00Z",
  assets: [{ filename: "photo.jpg", mediaType: "image/jpeg" }],
};

const haikuRun: RevealedRun = {
  evaluationId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1",
  analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc1",
  modelId: "claude-haiku-4-5",
  promptVersion: "v1",
  pipelineVersion: "v1",
  analysedAt: "2026-09-01T10:01:00Z",
  confidence: 0.9,
  result: { interest: { summary: "wants the pasta recipe" } },
  rated: false,
};
const sonnetRun: RevealedRun = {
  ...haikuRun,
  evaluationId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2",
  analysisId: "cccccccc-cccc-cccc-cccc-ccccccccccc2",
  modelId: "claude-sonnet-5",
  promptVersion: "v2",
  result: { interest: { summary: "wants a weeknight dinner idea" } },
};

const noop = () => {};

function occurrences(markup: string, pattern: RegExp): number {
  return markup.match(pattern)?.length ?? 0;
}

/** The words an evaluator actually reads, with markup and utility class names stripped out. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ");
}

describe("research console views", () => {
  it("AC2 the recall screen shows the capture and the recall questions only", () => {
    const markup = renderToStaticMarkup(
      <RecallPanel capture={capture} pending={false} onSubmit={noop} />,
    );

    expect(markup).toContain("https://example.test/pasta");
    expect(markup).toContain("for sunday");
    expect(markup).toContain("photo.jpg");
    expect(markup).toContain('value="remembered"');
    expect(markup).toContain('value="partial"');
    expect(markup).toContain('value="cannot_remember"');
    // Nothing the model produced, and no trace of the reveal phase, is on the page.
    expect(markup).not.toMatch(
      /wants the pasta recipe|claude-haiku|claude-sonnet|confidence|intentAccuracy|data-phase="reveal"/u,
    );
  });

  it("AC7 the recall screen presents exactly one capture and no archive or backlog", () => {
    const markup = renderToStaticMarkup(
      <RecallPanel capture={capture} pending={false} onSubmit={noop} />,
    );

    expect(occurrences(markup, /data-testid="capture-context"/gu)).toBe(1);
    expect(occurrences(markup, /<form/gu)).toBe(1);
    expect(visibleText(markup)).not.toMatch(/remaining|queue|backlog|of \d+|recommend|library|archive/iu);
    // Keyboard and touch: a real form with labelled controls and comfortably sized targets.
    expect(markup).toContain('type="submit"');
    expect(occurrences(markup, /<label/gu)).toBeGreaterThanOrEqual(4);
    expect(markup).toContain("min-h-12");
  });

  it("AC4/AC5 the reveal screen shows each run's own result and provenance", () => {
    const markup = renderToStaticMarkup(
      <RevealPanel
        capture={capture}
        runs={[haikuRun, sonnetRun]}
        rated={[]}
        pending={false}
        onRate={noop}
      />,
    );

    expect(markup).toContain("wants the pasta recipe");
    expect(markup).toContain("wants a weeknight dinner idea");
    expect(markup).toContain("claude-haiku-4-5");
    expect(markup).toContain("claude-sonnet-5");
    expect(markup).toContain("prompt v1");
    expect(markup).toContain("prompt v2");
    // Still one capture, but one rating form per run, each naming the row that binds it.
    expect(occurrences(markup, /data-testid="capture-context"/gu)).toBe(1);
    expect(occurrences(markup, /<form/gu)).toBe(2);
    expect(markup).toContain(`value="${haikuRun.evaluationId}"`);
    expect(markup).toContain(`value="${sonnetRun.evaluationId}"`);
    expect(markup).toContain(`data-analysis-id="${haikuRun.analysisId}"`);
    expect(markup).toContain(`data-analysis-id="${sonnetRun.analysisId}"`);
  });

  it("AC6 an already-recorded rating cannot be submitted twice from the screen", () => {
    const markup = renderToStaticMarkup(
      <RevealPanel
        capture={capture}
        runs={[haikuRun, sonnetRun]}
        rated={[haikuRun.evaluationId]}
        pending={false}
        onRate={noop}
      />,
    );

    expect(occurrences(markup, /disabled=""/gu)).toBe(1);
    expect(markup).toContain("Recorded");
  });

  it("AC6 the empty and error screens state the condition without fabricating data", () => {
    const empty = renderToStaticMarkup(<EmptyPanel />);
    const failed = renderToStaticMarkup(
      <ErrorPanel message="The research console is unavailable right now." onRetry={noop} />,
    );

    expect(empty).toContain("Nothing to evaluate right now.");
    // No queue length: a count would turn one capture at a time into a backlog to clear.
    expect(visibleText(empty)).not.toMatch(/\d/u);
    expect(failed).toContain("The research console is unavailable right now.");
    expect(failed).toContain("Try again");
    expect(`${empty}${failed}`).not.toMatch(/pasta|claude-|confidence/iu);
  });

  it("AC7 the capture panel renders capture-time fields only", () => {
    const markup = renderToStaticMarkup(<CapturePanel capture={capture} />);

    expect(markup).toContain('<time dateTime="2026-09-01T10:00:00Z">');
    expect(markup).toContain("whatsapp");
    expect(markup).not.toMatch(/interest|summary|model|confidence/iu);
  });
});
