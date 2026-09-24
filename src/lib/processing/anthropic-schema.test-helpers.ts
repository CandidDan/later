import { expect } from "vitest";

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxItems",
  "maximum",
  "maxLength",
  "minimum",
  "minLength",
  "multipleOf",
  "uniqueItems",
]);

/** Assert the transport schema contains no unsupported bounds and closes every object. */
export function expectAnthropicCompatibleSchema(schema: unknown): void {
  const unsupported: string[] = [];

  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    if (record.type === "object") {
      expect(record.additionalProperties, `${path} must be closed`).toBe(false);
    }
    for (const [key, child] of Object.entries(record)) {
      if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) unsupported.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  }

  visit(schema, "schema");
  expect(unsupported).toStrictEqual([]);
}
