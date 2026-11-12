import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDestination, type ResolveHost, type Row } from "../revisit/card";
import { encodeCursor, validId, type LibraryCursor } from "./cursor";
import { projectLibraryItem, type LibraryItem } from "./library";
import { assembleNarration, type NarrationOutcome } from "./narration";

export interface LibraryPage { items: LibraryItem[]; nextCursor: string | null }
export interface AppStore {
  library(before: LibraryCursor | undefined, limit: number): Promise<LibraryPage>;
  narration(captureId: string): Promise<NarrationOutcome | undefined>;
}
const metadataColumns = "id, capture_id, user_id, status, reason, word_count, content_sha256, created_at";
export function createAppStore(client: SupabaseClient, userId: string, resolve?: ResolveHost): AppStore {
  async function latestExtraction(id: string, includeText = false): Promise<Row | undefined> {
    const columns: string = includeText ? `${metadataColumns}, source_url, title, byline, site_name, paragraphs` : metadataColumns;
    const { data, error } = await client.from("capture_article_extractions")
      .select(columns)
      .eq("capture_id", id).eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).returns<Row[]>().maybeSingle();
    if (error) throw new Error("Extraction unavailable");
    return data ?? undefined;
  }
  async function libraryItem(id: string): Promise<LibraryItem> {
    const capture = await client.from("captures").select("id, user_id, capture_channel, capture_kind, raw_text, user_note, source_platform, captured_at")
      .eq("id", id).eq("user_id", userId).maybeSingle();
    if (capture.error || !capture.data) throw new Error("Capture unavailable");
    const [runs, extraction, ...jobs] = await Promise.all([
      client.from("capture_analyses").select("id, analysis_type, status, created_at, input_snapshot, result")
        .eq("capture_id", id).eq("analysis_type", "source_resolution").eq("status", "succeeded").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1),
      latestExtraction(id),
      ...["intent_analysis", "source_resolution", "article_extraction"].map(type => client.from("capture_jobs").select("job_type, status, created_at, id")
        .eq("capture_id", id).eq("job_type", type).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1)),
    ]);
    if (runs.error || jobs.some(job => job.error)) throw new Error("Library unavailable");
    return projectLibraryItem(capture.data, runs.data ?? [], extraction, jobs.flatMap(job => job.data ?? []), resolve);
  }
  return {
    async library(before, limit) {
      // This RPC commits exposure for the selected rows only, never a lookahead row.
      const { data, error } = await client.rpc("app_library_page", { p_before: before?.capturedAt ?? null, p_before_id: before?.captureId ?? null, p_limit: limit });
      if (error || !Array.isArray(data) || data.length > Math.max(1, Math.min(50, limit)) || data.some(row => !validId(row.capture_id) || typeof row.captured_at !== "string" || typeof row.has_more !== "boolean")) throw new Error("Library unavailable");
      const items: LibraryItem[] = [];
      // Bound concurrent database and DNS work even for a full fifty-item page.
      for (let offset = 0; offset < data.length; offset += 5) items.push(...await Promise.all(data.slice(offset, offset + 5).map(row => libraryItem(row.capture_id))));
      const last = data.at(-1);
      return { items, nextCursor: last?.has_more ? encodeCursor({ capturedAt: last.captured_at, captureId: last.capture_id }) : null };
    },
    async narration(id) {
      const exposed = await client.rpc("revisit_expose", { p_capture_id: id });
      if (exposed.error) throw new Error("Exposure unavailable");
      if (exposed.data === false) return undefined;
      if (exposed.data !== true) throw new Error("Exposure unavailable");
      // Await committed exposure before even querying the RLS-protected text.
      const extraction = await latestExtraction(id, true);
      const sourceUrl = extraction?.status === "full" ? await safeDestination(extraction.source_url, resolve) : undefined;
      return assembleNarration(id, extraction, sourceUrl);
    },
  };
}
