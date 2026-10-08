import { parseIntentResult } from "../../lib/processing/intent-result";
import type { RevealedRun } from "../../lib/research/types";

/** Render only the validated frozen schema. Unknown versions remain inspectable as raw data. */
export function IntentResultView({ run, number }: { run: RevealedRun; number: number }) {
  let result;
  try { result = parseIntentResult(run.result); } catch { /* Honest fallback below. */ }
  return <section aria-label={`Interpretation ${number}`} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h2 className="text-lg font-medium">Interpretation {number}</h2>
    <p className="text-sm text-zinc-500">A model interpretation, not source facts. Uncertainty is part of this frozen result.</p>
    {result ? <dl className="mt-3 flex flex-col gap-2 whitespace-pre-wrap">
      <dt className="font-medium">Inferred interest</dt><dd>{result.interest.summary}</dd>
      <dt className="font-medium">Content type</dt><dd>{result.contentType}</dd>
      <dt className="font-medium">Classification</dt><dd>{result.classification.value}</dd>
      <dt className="font-medium">Specificity</dt><dd>Not supplied by this result schema.</dd>
      <dt className="font-medium">Rationale — recorded evidence</dt>
      <dd><ul>{result.evidence.map((entry, index) => <li key={index}>{entry.observation} ({entry.field}; {entry.weight})</li>)}</ul></dd>
    </dl> : <p role="status">Readable interpretation unavailable: this result does not match the supported intent schema.</p>}
    <details className="mt-4">
      <summary className="cursor-pointer py-3 focus-visible:outline" aria-label={`Technical details for interpretation ${number}`}>Technical details and raw JSON</summary>
      <p>{run.modelId} · prompt {run.promptVersion} · pipeline {run.pipelineVersion}{run.confidence === null ? "" : ` · confidence ${run.confidence}`}</p>
      <p>Analysis {run.analysisId} · Evaluation {run.evaluationId}</p>
      {result && <p>Interest confidence {result.interest.confidence} · Classification confidence {result.classification.confidence} · Source confidence {result.underlyingSource.confidence}</p>}
      <pre className="whitespace-pre-wrap rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-900" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(run.result, null, 2)}</pre>
    </details>
  </section>;
}
