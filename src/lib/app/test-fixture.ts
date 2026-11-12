import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import { authenticateResearchRequest } from "../research/access";
import type { Row } from "../revisit/card";
import type { AppDependencies } from "./handler";
import { createAppStore } from "./store";
export const owner = "11111111-1111-4111-8111-111111111111";
export const other = "99999999-9999-4999-8999-999999999999";
export const captureId = "22222222-2222-4222-8222-222222222222";
export const foreignId = "33333333-3333-4333-8333-333333333333";
export const publicHost = async () => [{ address: "93.184.216.34" }];
export const request = (path: string, token = "owner") => new Request(`https://test.invalid/api/app/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
export const fullExtraction = (): Row => ({
  id: "extraction-1", capture_id: captureId, user_id: owner, status: "full", reason: null,
  source_url: "https://example.com/article", title: "An article", byline: "A Writer", site_name: "Example",
  paragraphs: ["  Original first paragraph.\nKeep this line.  ", "Second paragraph: café & <literal text>."],
  word_count: 250, content_sha256: "a".repeat(64), created_at: "2026-11-12T00:00:00Z",
});
export function appFixture(options: { captures?: Row[]; extractions?: Row[]; jobs?: Row[]; runs?: Row[] } = {}) {
  const captures = options.captures ?? [
    { id: captureId, user_id: owner, raw_text: "https://example.com/article", capture_kind: "url", captured_at: "2026-11-12T00:00:00.000001+00:00" },
    { id: foreignId, user_id: other, raw_text: "PRIVATE other user", capture_kind: "text", captured_at: "2026-11-11T00:00:00Z" },
  ];
  const tables: Record<string, Row[]> = { captures,
    capture_article_extractions: options.extractions ?? [fullExtraction()],
    capture_jobs: options.jobs ?? [],
    capture_analyses: options.runs ?? [{ id: "run-1", capture_id: captureId, analysis_type: "source_resolution", status: "succeeded", created_at: "2026-11-12T00:00:00Z" }],
  };
  const exposed = new Set<string>();
  const calls: string[] = [];
  const queries: Array<{ table: string; columns: string; filters: Record<string, unknown>; orders: string[]; limit?: number }> = [];
  const from = vi.fn((table: string) => {
    const info = { table, columns: "", filters: {} as Record<string, unknown>, orders: [] as string[], limit: undefined as number | undefined };
    queries.push(info);
    const execute = async () => {
      calls.push(`read:${table}`);
      if (table === "capture_article_extractions" && !exposed.has(String(info.filters.capture_id))) throw new Error("Text read before exposure");
      return (tables[table] ?? []).filter(row => Object.entries(info.filters).every(([key, value]) => row[key] === value))
        .sort((a, b) => {
          for (const field of info.orders) { const difference = String(b[field]).localeCompare(String(a[field])); if (difference) return difference; }
          return 0;
        }).slice(0, info.limit);
    };
    const query = {
      select: vi.fn((columns: string) => { info.columns = columns; return query; }),
      eq: vi.fn((key: string, value: unknown) => { info.filters[key] = value; return query; }),
      order: vi.fn((field: string) => { info.orders.push(field); return query; }),
      limit: vi.fn((count: number) => { info.limit = count; return query; }),
      returns: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: (await execute())[0] ?? null, error: null })),
      then: (done: (value: unknown) => unknown) => execute().then(data => done({ data, error: null })),
    };
    return query;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
    calls.push(`rpc:${name}`);
    if (name === "revisit_expose") {
      const owned = captures.some(c => c.id === args.p_capture_id && c.user_id === owner);
      if (owned) exposed.add(String(args.p_capture_id));
      return { data: owned, error: null };
    }
    const eligible = captures.filter(c => c.user_id === owner && !c.consumed_at)
      .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)) || String(b.id).localeCompare(String(a.id)))
      .filter(c => !args.p_before || String(c.captured_at) < String(args.p_before) || (c.captured_at === args.p_before && String(c.id) < String(args.p_before_id)));
    const page = eligible.slice(0, Number(args.p_limit));
    for (const row of page) exposed.add(String(row.id));
    return { data: page.map(c => ({ capture_id: c.id, captured_at: c.captured_at, has_more: eligible.length > page.length })), error: null };
  });
  const store = createAppStore({ from, rpc } as unknown as SupabaseClient, owner, publicHost);
  const storeFor = vi.fn(() => store);
  const deps: AppDependencies = {
    authenticate: req => authenticateResearchRequest(req, { researchUserId: owner, resolveUser: async token => token === "owner" ? owner : token === "stranger" ? other : undefined }), storeFor,
  };
  return { deps, store, storeFor, rpc, from, exposed, calls, queries, tables };
}
