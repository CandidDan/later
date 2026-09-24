import { IntentAnalysisError } from "./errors";
import { IntentResultSchemaError } from "./intent-result";

/**
 * Safe operational evidence for a failed intent attempt.
 *
 * Later deliberately discards provider-controlled text: an error from the provider can quote
 * the capture, the prompt, an authorization header or a key back at us, and a log line is the
 * least protected place any of that could land. That boundary stays. What it hid, though, was
 * the one question operations actually needs answered — *which kind* of failure this was —
 * because every transport failure was recorded as the same opaque code.
 *
 * So nothing here passes a provider value through. A value is read only to be matched against
 * an allowlist; on a match the event carries a constant of ours, and on anything else the
 * field is dropped. The two exceptions are both bounded and both ours by construction: a
 * numeric HTTP status range-checked to 100-599, and a request id that must match the
 * provider's documented `req_…` shape before it is allowed to travel.
 */

export const ANTHROPIC_FAILURE_CATEGORIES = [
  "authentication",
  "permission",
  "model_not_found",
  "invalid_request",
  "rate_limit",
  "provider_server",
  "timeout",
  "network",
  "response_invalid",
  "result_schema_invalid",
  "unknown",
] as const;

export type AnthropicFailureCategory = (typeof ANTHROPIC_FAILURE_CATEGORIES)[number];

/** The operations that can fail at the provider boundary, named rather than free text. */
export type IntentFailureOperation = "intent_analysis" | "intent_analysis_enriched";

export interface IntentFailureContext {
  operation: IntentFailureOperation;
  jobId: string;
  captureId: string;
}

/**
 * The whole event. Every field is either a literal, an internal id, or a value that survived
 * validation — there is no open-ended field for an error to leak into.
 */
export interface AnthropicFailureDiagnostic {
  event: "intent_provider_failure";
  provider: "anthropic";
  operation: IntentFailureOperation;
  jobId: string;
  captureId: string;
  category: AnthropicFailureCategory;
  /** Whether the category is worth another attempt. Advisory — the queue still owns retries. */
  retryable: boolean;
  status?: number;
  requestId?: string;
}

/** Categories where another attempt can plausibly succeed without anyone changing anything. */
const RETRYABLE_CATEGORIES: ReadonlySet<AnthropicFailureCategory> = new Set<AnthropicFailureCategory>([
  "rate_limit",
  "provider_server",
  "timeout",
  "network",
]);

/** HTTP status is the most authoritative signal the provider gives us, so it is read first. */
function categoryForStatus(status: number): AnthropicFailureCategory | undefined {
  if (status >= 500) return "provider_server";

  switch (status) {
    case 400:
    case 422:
      return "invalid_request";
    case 401:
      return "authentication";
    case 403:
      return "permission";
    case 404:
      return "model_not_found";
    case 408:
      return "timeout";
    case 429:
      return "rate_limit";
    default:
      return undefined;
  }
}

/**
 * Error class names, matched exactly. A name is only ever a lookup key here: an unrecognised
 * one selects nothing and is discarded, so provider text in `name` cannot reach the event.
 */
const CATEGORY_BY_ERROR_NAME: Readonly<Record<string, AnthropicFailureCategory>> = {
  AuthenticationError: "authentication",
  PermissionDeniedError: "permission",
  NotFoundError: "model_not_found",
  BadRequestError: "invalid_request",
  UnprocessableEntityError: "invalid_request",
  RateLimitError: "rate_limit",
  InternalServerError: "provider_server",
  APIConnectionTimeoutError: "timeout",
  TimeoutError: "timeout",
  AbortError: "timeout",
  APIConnectionError: "network",
};

/** Node/undici transport codes, matched the same way and for the same reason. */
const CATEGORY_BY_ERROR_CODE: Readonly<Record<string, AnthropicFailureCategory>> = {
  ABORT_ERR: "timeout",
  ETIMEDOUT: "timeout",
  ESOCKETTIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  EAI_AGAIN: "network",
  ECONNABORTED: "network",
  ECONNREFUSED: "network",
  ECONNRESET: "network",
  EHOSTUNREACH: "network",
  ENETUNREACH: "network",
  ENOTFOUND: "network",
  EPIPE: "network",
  UND_ERR_SOCKET: "network",
};

/** Anthropic's documented request id shape. Anything else is not a request id to us. */
const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9]{1,60}$/;

/**
 * A thrown value is not trustworthy enough to dot into: it can be a proxy, or an object whose
 * getter throws. Reading through here means a hostile shape degrades to `undefined` instead of
 * turning one recorded failure into a second, unhandled one.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;

  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeStatus(error: unknown): number | undefined {
  const status = readProperty(error, "status");

  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function allowlisted(
  error: unknown,
  key: string,
  table: Readonly<Record<string, AnthropicFailureCategory>>,
): AnthropicFailureCategory | undefined {
  const value = readProperty(error, key);

  return typeof value === "string" ? table[value] : undefined;
}

/**
 * The request id correlates our failure with the provider's own record of it, which is the
 * whole point of carrying it. It travels only if it matches the documented shape: absent,
 * malformed, oversized or non-string ids are dropped, never copied in the hope of being useful.
 */
function safeRequestId(error: unknown): string | undefined {
  for (const key of ["request_id", "requestID", "requestId"]) {
    const value = readProperty(error, key);

    if (typeof value === "string" && REQUEST_ID_PATTERN.test(value)) return value;
  }

  return undefined;
}

function categorise(error: unknown): AnthropicFailureCategory {
  // Our own failures are already safe categories: the provider answered, the answer was unusable.
  if (error instanceof IntentResultSchemaError) return "result_schema_invalid";
  if (error instanceof IntentAnalysisError) return "response_invalid";

  const status = safeStatus(error);

  return (status === undefined ? undefined : categoryForStatus(status))
    ?? allowlisted(error, "name", CATEGORY_BY_ERROR_NAME)
    ?? allowlisted(error, "code", CATEGORY_BY_ERROR_CODE)
    ?? "unknown";
}

/**
 * Describe a failed attempt. Total by construction: any value at all — a string, `null`, a
 * proxy that throws on every read — yields a bounded `unknown` diagnostic rather than an error.
 */
export function describeIntentFailure(
  error: unknown,
  context: IntentFailureContext,
): AnthropicFailureDiagnostic {
  let category: AnthropicFailureCategory = "unknown";
  let status: number | undefined;
  let requestId: string | undefined;

  try {
    category = categorise(error);
    status = safeStatus(error);
    requestId = safeRequestId(error);
  } catch {
    // Deriving evidence must never cost more than the evidence is worth.
    category = "unknown";
    status = undefined;
    requestId = undefined;
  }

  return {
    event: "intent_provider_failure",
    provider: "anthropic",
    operation: context.operation,
    jobId: context.jobId,
    captureId: context.captureId,
    category,
    retryable: RETRYABLE_CATEGORIES.has(category),
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export type FailureDiagnosticSink = (event: AnthropicFailureDiagnostic) => void;

/**
 * The default sink. The event is a fixed-shape, primitive-only object of our own making, so
 * serialising it cannot reach a getter, cannot cycle, and cannot throw.
 */
export const logFailureDiagnostic: FailureDiagnosticSink = (event) => {
  console.error(JSON.stringify(event));
};

/**
 * Emit exactly one diagnostic, and never let emitting one change the outcome of the attempt
 * it describes. A failed attempt that is recorded correctly but logged badly is still a
 * correctly recorded attempt.
 */
export function emitFailureDiagnostic(
  event: AnthropicFailureDiagnostic,
  sink: FailureDiagnosticSink = logFailureDiagnostic,
): void {
  try {
    sink(event);
  } catch {
    // Intentionally swallowed: see above.
  }
}

/**
 * The allowlisted code stored against the attempt. Categories are finer-grained than the
 * stored codes on purpose — the database keeps the three durable codes it has always kept,
 * while the diagnostic carries the detail that only operations needs.
 */
export function failureErrorCode(category: AnthropicFailureCategory): string {
  switch (category) {
    case "result_schema_invalid":
      return "result_schema_invalid";
    case "response_invalid":
      return "provider_response_invalid";
    default:
      return "provider_unavailable";
  }
}
