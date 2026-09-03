/**
 * Raised when Anthropic answers but the answer is unusable — a refusal, no text, or output
 * that is not JSON. Distinct from a transport failure, and distinct from a well-formed
 * response that fails the result schema.
 */
export class IntentAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentAnalysisError";
  }
}
