import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDestination, projectCard, text, type CaptureCard, type Row } from "./card";

export type RevisitAction = "open" | "defer" | "consume";
export interface ActionOutcome { status: "applied" | "unavailable"; repeated?: boolean; action?: RevisitAction; occurredAt?: string; destination?: string | null }
export interface RevisitStore {
  batch(): Promise<CaptureCard[]>;
  action(captureId: string, requestId: string, action: RevisitAction): Promise<ActionOutcome>;
  card(captureId: string): Promise<CaptureCard | undefined>;
  asset(captureId: string, assetId: string): Promise<{ bytes: Blob; filename: string; mediaType: string } | undefined>;
}
export function ownedObjectPath(path: unknown, userId: string, captureId: string): path is string {
  if (typeof path !== "string") return false;
  const prefix = `captures/${userId}/${captureId}/`;
  const filename = path.slice(prefix.length);
  return path.startsWith(prefix) && filename.length > 0 && filename.length <= 512 && !/[\\/%\x00-\x1f]/.test(filename) && filename !== "." && filename !== "..";
}
export function createRevisitStore(client: SupabaseClient, userId: string): RevisitStore {
  async function capture(id: string): Promise<Row | undefined> {
    const { data, error } = await client.from("captures").select("id, user_id, capture_channel, capture_kind, raw_text, user_note, source_platform, captured_at").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error("Capture unavailable");
    return data ?? undefined;
  }
  async function expose(id: string) {
    const { data, error } = await client.rpc("revisit_expose", { p_capture_id: id });
    if (error || data !== true) throw new Error("Exposure unavailable");
  }
  async function card(id: string): Promise<CaptureCard | undefined> {
      const row = await capture(id);
      if (!row) return undefined;
      const [runs, assets] = await Promise.all([
        client.from("capture_analyses").select("id, analysis_type, status, created_at, input_snapshot, result").eq("capture_id", id).eq("analysis_type", "source_resolution").eq("status", "succeeded").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1),
        client.from("capture_assets").select("id, filename, media_type, observed_media_type, storage_state").eq("capture_id", id).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(30),
      ]);
      if (runs.error || assets.error) throw new Error("Card unavailable");
      return projectCard(row, runs.data ?? [], assets.data ?? []);
  }
  return {
    async batch() {
      const { data, error } = await client.rpc("revisit_batch");
      if (error || !Array.isArray(data) || data.length > 3 || data.some(id => typeof id !== "string")) throw new Error("Batch unavailable");
      const cards = await Promise.all(data.map(id => card(id)));
      if (cards.some(c => !c)) throw new Error("Batch unavailable");
      return cards as CaptureCard[];
    },
    async card(id) {
      const result = await card(id);
      if (result) await expose(id);
      return result;
    },
    async action(id, requestId, action) {
      // Idempotent retries retain the original event, including its destination.
      const prior = await client.from("capture_revisit_events").select("capture_id, action, destination").eq("user_id", userId).eq("request_id", requestId).maybeSingle();
      if (prior.error) throw new Error("Action unavailable");
      if (prior.data && (prior.data.capture_id !== id || prior.data.action !== action)) throw new Error("Request conflict");
      let destination: string | undefined;
      if (action === "open") {
        const result = prior.data ? undefined : await card(id);
        destination = await safeDestination(prior.data?.destination ?? result?.sourceDestination ?? result?.originalDestination);
        if (!destination) return { status: "unavailable" };
        await expose(id);
      }
      const { data, error } = await client.rpc("revisit_action", { p_capture_id: id, p_request_id: requestId, p_action: action, p_destination: destination ?? null });
      if (error || !data || data.status !== "applied") throw new Error("Action unavailable");
      if (action === "open") {
        const safe = await safeDestination(data.destination);
        if (!safe) return { status: "unavailable" };
        return { ...data, destination: safe };
      }
      return data;
    },
    async asset(id, assetId) {
      if (!await capture(id)) return undefined;
      const { data, error } = await client.from("capture_assets").select("filename, storage_path, storage_state, observed_media_type").eq("capture_id", id).eq("id", assetId).maybeSingle();
      if (error) throw new Error("Asset unavailable");
      if (!data || data.storage_state !== "stored" || !ownedObjectPath(data.storage_path, userId, id)) return undefined;
      await expose(id);
      const download = await client.storage.from("capture-assets").download(data.storage_path);
      if (download.error || !download.data) return undefined;
      return { bytes: download.data, filename: text(data.filename, 255), mediaType: text(data.observed_media_type, 100) };
    },
  };
}
