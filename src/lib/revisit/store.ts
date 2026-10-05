import type { SupabaseClient } from "@supabase/supabase-js";
import { projectCard, text, type CaptureCard, type Row } from "./card";

export interface RevisitStore {
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
  return {
    async card(id) {
      const row = await capture(id);
      if (!row) return undefined;
      const [runs, assets] = await Promise.all([
        client.from("capture_analyses").select("id, analysis_type, status, created_at, input_snapshot, result").eq("capture_id", id).eq("analysis_type", "source_resolution").eq("status", "succeeded").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1),
        client.from("capture_assets").select("id, filename, media_type, observed_media_type, storage_state").eq("capture_id", id).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(30),
      ]);
      if (runs.error || assets.error) throw new Error("Card unavailable");
      return projectCard(row, runs.data ?? [], assets.data ?? []);
    },
    async asset(id, assetId) {
      if (!await capture(id)) return undefined;
      const { data, error } = await client.from("capture_assets").select("filename, storage_path, storage_state, observed_media_type").eq("capture_id", id).eq("id", assetId).maybeSingle();
      if (error) throw new Error("Asset unavailable");
      if (!data || data.storage_state !== "stored" || !ownedObjectPath(data.storage_path, userId, id)) return undefined;
      const download = await client.storage.from("capture-assets").download(data.storage_path);
      if (download.error || !download.data) return undefined;
      return { bytes: download.data, filename: text(data.filename, 255), mediaType: text(data.observed_media_type, 100) };
    },
  };
}
