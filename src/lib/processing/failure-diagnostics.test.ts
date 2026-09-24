import { describe, expect, it, vi } from "vitest";

import {
  describeIntentFailure,
  emitFailureDiagnostic,
  failureErrorCode,
  logFailureDiagnostic,
  type AnthropicFailureDiagnostic,
} from "./failure-diagnostics";
import { IntentAnalysisError } from "./errors";
import { IntentResultSchemaError } from "./intent-result";

const context = {
  operation: "intent_analysis",
  jobId: "job-77",
  captureId: "capture-9",
} as const;

/** An SDK-shaped error: the class name and the HTTP status the real client would carry. */
function apiError(name: string, status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("provider text that must never be logged"), { name, status, ...extra });
}

describe("describeIntentFailure", () => {
  it.each([
    ["an authentication failure", apiError("AuthenticationError", 401), "authentication", 401, false],
    ["a model-access denial", apiError("PermissionDeniedError", 403), "permission", 403, false],
    ["an unknown model", apiError("NotFoundError", 404), "model_not_found", 404, false],
    ["a rejected request", apiError("BadRequestError", 400), "invalid_request", 400, false],
    ["a rate limit", apiError("RateLimitError", 429), "rate_limit", 429, true],
    ["a provider 5xx", apiError("InternalServerError", 500), "provider_server", 500, true],
    ["an overloaded provider", apiError("InternalServerError", 529), "provider_server", 529, true],
  ])(
    "AC1 categorises %s with its status and retryability",
    (_label, error, category, status, retryable) => {
      expect(describeIntentFailure(error, context)).toStrictEqual({
        event: "intent_provider_failure",
        provider: "anthropic",
        operation: "intent_analysis",
        jobId: "job-77",
        captureId: "capture-9",
        category,
        retryable,
        status,
      });
    },
  );

  it.each([
    ["an SDK connection timeout", Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" }), "timeout"],
    ["an aborted socket", Object.assign(new Error("x"), { name: "AbortError" }), "timeout"],
    ["a socket timeout code", Object.assign(new Error("x"), { code: "ETIMEDOUT" }), "timeout"],
    ["an SDK connection error", Object.assign(new Error("x"), { name: "APIConnectionError" }), "network"],
    ["a refused connection", Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "network"],
    ["a DNS failure", Object.assign(new Error("x"), { code: "EAI_AGAIN" }), "network"],
  ])("AC1 categorises %s as retryable transport with no status", (_label, error, category) => {
    const diagnostic = describeIntentFailure(error, context);

    expect(diagnostic).toMatchObject({ category, retryable: true, operation: "intent_analysis" });
    expect(diagnostic).not.toHaveProperty("status");
  });

  it("AC1 carries the operation of an enriched attempt and both internal ids", () => {
    expect(describeIntentFailure(apiError("RateLimitError", 429), {
      operation: "intent_analysis_enriched",
      jobId: "job-12",
      captureId: "capture-3",
    })).toMatchObject({
      operation: "intent_analysis_enriched",
      jobId: "job-12",
      captureId: "capture-3",
      provider: "anthropic",
    });
  });

  it("AC1 reports an unrecognised HTTP status without inventing a category", () => {
    const diagnostic = describeIntentFailure(apiError("APIError", 418), context);

    expect(diagnostic).toMatchObject({ category: "unknown", status: 418, retryable: false });
  });

  it("AC2 includes a request id that matches the provider's documented shape", () => {
    expect(describeIntentFailure(
      apiError("RateLimitError", 429, { request_id: "req_011CSHoEeqs5C35K2UUqR6c6" }),
      context,
    )).toMatchObject({ requestId: "req_011CSHoEeqs5C35K2UUqR6c6" });
  });

  it.each([
    ["absent", {}],
    ["null", { request_id: null }],
    ["non-string", { request_id: 42 }],
    ["empty", { request_id: "" }],
    ["unprefixed", { request_id: "011CSHoEeqs5C35K2UUqR6c6" }],
    ["punctuated", { request_id: "req_011 Authorization: Bearer sk-ant-secret" }],
    ["oversized", { request_id: `req_${"a".repeat(61)}` }],
  ])("AC2 omits an %s request id rather than copying it", (_label, extra) => {
    const diagnostic = describeIntentFailure(apiError("RateLimitError", 429, extra), context);

    expect(diagnostic).not.toHaveProperty("requestId");
    expect(JSON.stringify(diagnostic)).not.toContain("sk-ant-secret");
  });

  it("AC3 emits none of the error's message, name, stack, cause, headers or bodies", () => {
    const secrets = [
      "sk-ant-api03-SUPERSECRET",
      "Bearer sk-ant-api03-SUPERSECRET",
      "the bit about sourdough starters",
      "https://www.youtube.com/watch?v=abc",
      "invalid x-api-key: sk-ant-api03-SUPERSECRET",
    ];
    const error = Object.assign(
      new Error(`invalid x-api-key: sk-ant-api03-SUPERSECRET for the bit about sourdough starters`),
      {
        name: "AuthenticationError",
        status: 401,
        stack: "AuthenticationError: sk-ant-api03-SUPERSECRET\n  at https://www.youtube.com/watch?v=abc",
        cause: new Error("the bit about sourdough starters"),
        headers: { authorization: "Bearer sk-ant-api03-SUPERSECRET", "x-api-key": "sk-ant-api03-SUPERSECRET" },
        request: { body: { messages: [{ role: "user", content: "the bit about sourdough starters" }] } },
        response: { body: { error: { message: "invalid x-api-key: sk-ant-api03-SUPERSECRET" } } },
        error: { type: "authentication_error", message: "the bit about sourdough starters" },
      },
    );

    const diagnostic = describeIntentFailure(error, context);
    const serialised = JSON.stringify(diagnostic);

    expect(diagnostic).toStrictEqual({
      event: "intent_provider_failure",
      provider: "anthropic",
      operation: "intent_analysis",
      jobId: "job-77",
      captureId: "capture-9",
      category: "authentication",
      retryable: false,
      status: 401,
    });
    for (const secret of secrets) expect(serialised).not.toContain(secret);
    for (const field of ["message", "name", "stack", "cause", "headers", "request", "response"]) {
      expect(Object.keys(diagnostic)).not.toContain(field);
    }
    expect(serialised).not.toContain("sourdough");
  });

  it.each([
    ["a bare string", "sk-ant-api03-SUPERSECRET thrown as a string"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a plain object", { message: "sk-ant-api03-SUPERSECRET", status: "not a number" }],
    ["an array", ["sk-ant-api03-SUPERSECRET"]],
    ["an out-of-range status", Object.assign(new Error("x"), { status: 9000 })],
  ])("AC4 describes %s as a bounded unknown failure", (_label, thrown) => {
    const diagnostic = describeIntentFailure(thrown, context);

    expect(diagnostic).toStrictEqual({
      event: "intent_provider_failure",
      provider: "anthropic",
      operation: "intent_analysis",
      jobId: "job-77",
      captureId: "capture-9",
      category: "unknown",
      retryable: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("SUPERSECRET");
  });

  it("AC4 survives a value whose every property getter throws", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("sk-ant-api03-SUPERSECRET");
      },
    });

    expect(() => describeIntentFailure(hostile, context)).not.toThrow();
    expect(describeIntentFailure(hostile, context)).toMatchObject({ category: "unknown", retryable: false });
  });

  it("AC4 does not serialise the thrown value when the default sink logs it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      logFailureDiagnostic(describeIntentFailure("sk-ant-api03-SUPERSECRET", context));

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toBe(JSON.stringify({
        event: "intent_provider_failure",
        provider: "anthropic",
        operation: "intent_analysis",
        jobId: "job-77",
        captureId: "capture-9",
        category: "unknown",
        retryable: false,
      }));
    } finally {
      error.mockRestore();
    }
  });
});

describe("emitFailureDiagnostic", () => {
  it("AC1 sends exactly one event to the supplied sink", () => {
    const events: AnthropicFailureDiagnostic[] = [];

    emitFailureDiagnostic(describeIntentFailure(apiError("RateLimitError", 429), context), (event) => {
      events.push(event);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "rate_limit", retryable: true, status: 429 });
  });

  it("AC4 never turns a logging failure into a second thrown error", () => {
    expect(() => emitFailureDiagnostic(describeIntentFailure(null, context), () => {
      throw new Error("sink is down");
    })).not.toThrow();
  });
});

describe("failureErrorCode", () => {
  it.each([
    ["result_schema_invalid", "result_schema_invalid"],
    ["response_invalid", "provider_response_invalid"],
    ["authentication", "provider_unavailable"],
    ["rate_limit", "provider_unavailable"],
    ["unknown", "provider_unavailable"],
  ] as const)("AC5 keeps the stored code for %s unchanged", (category, code) => {
    expect(failureErrorCode(category)).toBe(code);
  });

  it("AC5 keeps our own unusable-answer errors out of the provider categories", () => {
    expect(describeIntentFailure(new IntentResultSchemaError("contentType must be one of"), context))
      .toMatchObject({ category: "result_schema_invalid", retryable: false });
    expect(describeIntentFailure(new IntentAnalysisError("Anthropic declined"), context))
      .toMatchObject({ category: "response_invalid", retryable: false });
  });
});
