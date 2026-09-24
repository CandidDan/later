import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

type ObjectJsonSchema = Parameters<typeof jsonSchemaOutputFormat>[0];

function restoreEnums(source: unknown, target: unknown): void {
  if (source === null || typeof source !== "object" || target === null || typeof target !== "object") {
    return;
  }

  const sourceRecord = source as Record<string, unknown>;
  const targetRecord = target as Record<string, unknown>;
  if (Array.isArray(sourceRecord.enum)) targetRecord.enum = structuredClone(sourceRecord.enum);

  for (const key of ["properties", "$defs", "definitions"] as const) {
    const sourceChildren = sourceRecord[key];
    const targetChildren = targetRecord[key];
    if (sourceChildren === null || typeof sourceChildren !== "object"
        || targetChildren === null || typeof targetChildren !== "object") continue;
    for (const [name, child] of Object.entries(sourceChildren)) {
      restoreEnums(child, (targetChildren as Record<string, unknown>)[name]);
    }
  }

  restoreEnums(sourceRecord.items, targetRecord.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const sourceVariants = sourceRecord[key];
    const targetVariants = targetRecord[key === "oneOf" ? "anyOf" : key];
    if (!Array.isArray(sourceVariants) || !Array.isArray(targetVariants)) continue;
    sourceVariants.forEach((variant, index) => restoreEnums(variant, targetVariants[index]));
  }
}

/**
 * Transform a strict local contract for Anthropic transport while retaining supported enum
 * constraints that SDK 0.123 otherwise moves into descriptions with unsupported bounds.
 */
export function anthropicOutputFormat(schema: ObjectJsonSchema) {
  const format = jsonSchemaOutputFormat(schema);
  restoreEnums(schema, format.schema);
  return format;
}
