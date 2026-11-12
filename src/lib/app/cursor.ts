export const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export interface LibraryCursor { capturedAt: string; captureId: string }
// Keep the database's microseconds, rather than rounding timestamps through Date.toISOString().
const validTime = (time: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time));
export function encodeCursor(cursor: LibraryCursor): string {
  if (!validId(cursor.captureId) || !validTime(cursor.capturedAt)) throw new Error("Invalid cursor");
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeCursor(value: string): LibraryCursor {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed.captureId !== "string" || typeof parsed.capturedAt !== "string" || !validId(parsed.captureId) || !validTime(parsed.capturedAt)) throw new Error("Invalid cursor");
  return { capturedAt: parsed.capturedAt, captureId: parsed.captureId };
}
export function parseLibraryQuery(request: Request): { before?: LibraryCursor; limit: number } {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  if (params.getAll("before").length > 1 || params.getAll("limit").length > 1 || (rawLimit !== null && !/^-?\d{1,9}$/.test(rawLimit))) throw new Error("Invalid query");
  return { before: params.has("before") ? decodeCursor(params.get("before")!) : undefined, limit: rawLimit === null ? 50 : Math.max(1, Math.min(50, Number(rawLimit))) };
}
