import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntentResultView } from "./intent-result";
import type { RevealedRun } from "../../lib/research/types";

const result = { contentType: "article", interest: { summary: "Possibly a reference", confidence: 0.2 }, classification: { value: "uncertain", confidence: 0.1 }, underlyingSource: { hints: [], confidence: 0.3 }, resolutionRequired: false, evidence: [{ field: "userNote", observation: "Maybe relevant", weight: "supporting" }] };
const run: RevealedRun = { result, analysisId: "analysis", evaluationId: "evaluation", modelId: "model", promptVersion: "prompt", pipelineVersion: "pipeline", analysedAt: "2026-01-01", confidence: 0.1, rated: false };
describe("later-0021 frozen intent presentation", () => {
  it("AC2 preserves validated uncertainty and confines technical fields to a closed disclosure", () => {
    const html = renderToStaticMarkup(<IntentResultView run={run} number={2} />);
    const [readable, technical] = html.split("<details");
    expect(readable).toContain("Possibly a reference"); expect(readable).toContain("uncertain");
    expect(readable).toContain("Maybe relevant"); expect(readable).toContain("Not supplied by this result schema.");
    expect(readable).not.toContain("confidence 0.1"); expect(technical).toContain("confidence 0.1");
    expect(technical).toContain("Technical details for interpretation 2"); expect(technical).not.toMatch(/^ open/);
    expect(run.result).toEqual(result);
  });
  it.each([null, [], "unknown", { ...result, specificity: "invented" }, { ...result, interest: { summary: 42 } }])("AC4 malformed or unknown schema has a fallback and unchanged raw data: %j", value => {
    const html = renderToStaticMarkup(<IntentResultView run={{ ...run, result: value }} number={1} />);
    expect(html.split("<details")[0]).toContain("Readable interpretation unavailable");
    expect(html).toContain("<pre");
  });
  it("AC6 escapes arbitrary result HTML and wraps long fields and JSON", () => {
    const html = renderToStaticMarkup(<IntentResultView run={{ ...run, result: { ...result, interest: { summary: '<img src=x onerror="alert(1)">' + 'x'.repeat(5000), confidence: 0.1 } } }} number={1} />);
    expect(html).not.toContain("<img"); expect(html).toContain("&lt;img");
    expect(html).toContain("overflow-wrap:anywhere"); expect(html).toContain("whitespace-pre-wrap");
  });
});
