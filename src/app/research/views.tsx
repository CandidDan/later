import { INTENT_ACCURACIES, RECALL_STATUSES } from "@/lib/research/types";
import type { CaptureContext, RevealedRun } from "@/lib/research/types";

const RECALL_LABELS: Record<(typeof RECALL_STATUSES)[number], string> = {
  remembered: "I remember why I saved this",
  partial: "I partly remember",
  cannot_remember: "I cannot remember",
};

const ACCURACY_LABELS: Record<(typeof INTENT_ACCURACIES)[number], string> = {
  correct: "Correct",
  close: "Close",
  wrong: "Wrong",
};

const panel = "w-full max-w-2xl rounded-lg border border-zinc-200 p-6 dark:border-zinc-800";
const choice =
  "flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-zinc-200 px-4 py-3 " +
  "text-base has-[:focus-visible]:outline has-[:focus-visible]:outline-2 dark:border-zinc-800";
const action =
  "min-h-12 rounded-md bg-zinc-900 px-5 text-base font-medium text-zinc-50 " +
  "disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900";

/**
 * The capture exactly as it was saved. This is the only thing on screen during recall — the
 * evaluator has to answer from memory, and anything inferred would answer for them.
 */
export function CapturePanel({ capture }: { capture: CaptureContext }) {
  return (
    <article className="flex flex-col gap-2" data-testid="capture-context">
      <h2 className="text-sm uppercase tracking-wide text-zinc-500">What you saved</h2>
      {capture.rawText ? <p className="whitespace-pre-wrap text-lg">{capture.rawText}</p> : null}
      {capture.userNote ? (
        <p className="whitespace-pre-wrap text-base text-zinc-600 dark:text-zinc-400">
          {capture.userNote}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1 text-sm text-zinc-500">
        {capture.assets.map((asset) => (
          <li key={asset.filename}>
            {asset.filename}
            {asset.mediaType ? ` (${asset.mediaType})` : ""}
          </li>
        ))}
      </ul>
      <p className="text-sm text-zinc-500">
        {capture.channel} · saved <time dateTime={capture.capturedAt}>{capture.capturedAt}</time>
      </p>
    </article>
  );
}

export interface RecallPanelProps {
  capture: CaptureContext;
  pending: boolean;
  onSubmit(form: FormData): void;
}

/** Phase one. Nothing here is, or can be, model output. */
export function RecallPanel({ capture, pending, onSubmit }: RecallPanelProps) {
  return (
    <section className={panel} data-phase="recall">
      <CapturePanel capture={capture} />
      <form
        className="mt-6 flex flex-col gap-4"
        action={onSubmit}
        aria-label="Unaided recall"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-base font-medium">
            Before anything is revealed: do you remember why you saved this?
          </legend>
          {RECALL_STATUSES.map((status, index) => (
            <label className={choice} key={status}>
              <input
                type="radio"
                name="recallStatus"
                value={status}
                defaultChecked={index === 0}
                required
              />
              {RECALL_LABELS[status]}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-2 text-base">
          What were you interested in? (leave empty if you cannot remember)
          <textarea
            name="rememberedInterest"
            rows={3}
            className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          />
        </label>
        <button className={action} type="submit" disabled={pending}>
          Save my answer, then show me what the model said
        </button>
      </form>
    </section>
  );
}

export interface RevealPanelProps {
  capture: CaptureContext;
  runs: readonly RevealedRun[];
  rated: readonly string[];
  pending: boolean;
  onRate(form: FormData): void;
}

/**
 * Phase two, reachable only once recall is stored. Each run is rated on its own form carrying
 * its own evaluation id, so two runs of one capture never collapse into a single verdict.
 */
export function RevealPanel({ capture, runs, rated, pending, onRate }: RevealPanelProps) {
  return (
    <section className={panel} data-phase="reveal">
      <CapturePanel capture={capture} />
      {runs.map((run) => (
        <form
          className="mt-6 flex flex-col gap-4 border-t border-zinc-200 pt-6 dark:border-zinc-800"
          action={onRate}
          aria-label={`Rate run ${run.analysisId}`}
          data-analysis-id={run.analysisId}
          key={run.evaluationId}
        >
          <input type="hidden" name="evaluationId" value={run.evaluationId} />
          <h2 className="text-sm uppercase tracking-wide text-zinc-500">
            What the model inferred
          </h2>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
            {JSON.stringify(run.result, null, 2)}
          </pre>
          <p className="text-sm text-zinc-500">
            {run.modelId} · prompt {run.promptVersion} · pipeline {run.pipelineVersion}
            {run.confidence === null ? "" : ` · confidence ${run.confidence}`}
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-base font-medium">Was that your interest?</legend>
            {INTENT_ACCURACIES.map((accuracy, index) => (
              <label className={choice} key={accuracy}>
                <input
                  type="radio"
                  name="intentAccuracy"
                  value={accuracy}
                  defaultChecked={index === 0}
                  required
                />
                {ACCURACY_LABELS[accuracy]}
              </label>
            ))}
          </fieldset>
          <label className={choice}>
            <input type="checkbox" name="stillInterested" value="yes" />
            I am still interested in this
          </label>
          <label className={choice}>
            <input type="checkbox" name="consumedBeforeEvaluation" value="yes" />
            I already went back to this before today
          </label>
          <label className="flex flex-col gap-2 text-base">
            Anything else worth recording?
            <textarea
              name="notes"
              rows={2}
              className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
            />
          </label>
          <button className={action} type="submit" disabled={pending || rated.includes(run.evaluationId)}>
            {rated.includes(run.evaluationId) ? "Recorded" : "Record this rating"}
          </button>
        </form>
      ))}
    </section>
  );
}

/** Nothing to evaluate. Deliberately not a queue length: a count is a backlog to clear. */
export function EmptyPanel() {
  return (
    <section className={panel} data-phase="empty">
      <p className="text-lg">Nothing to evaluate right now.</p>
    </section>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <section className={panel} data-phase="error">
      <p className="text-lg">{message}</p>
      <button className={`${action} mt-4`} type="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

export function SignInPanel({
  message,
  pending,
  onSubmit,
}: {
  message: string | null;
  pending: boolean;
  onSubmit(form: FormData): void;
}) {
  return (
    <section className={panel} data-phase="signed_out">
      <form className="flex flex-col gap-4" action={onSubmit} aria-label="Sign in">
        <label className="flex flex-col gap-2 text-base">
          Email
          <input
            className="min-h-12 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
            type="email"
            name="email"
            autoComplete="email"
            required
          />
        </label>
        <label className="flex flex-col gap-2 text-base">
          Password
          <input
            className="min-h-12 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>
        {message ? <p className="text-base text-red-600">{message}</p> : null}
        <button className={action} type="submit" disabled={pending}>
          Sign in
        </button>
      </form>
    </section>
  );
}
