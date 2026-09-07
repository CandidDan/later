import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaptureJob } from "../jobs/types";
import { MediaError, validateMedia, type DownloadedMedia, type MediaEvidence } from "./media";

export interface MediaAsset {
  id: string; captureId: string; storagePath: string; providerUrl: string; mediaType: string | null;
}
export interface MediaStore {
  claim(): Promise<CaptureJob | undefined>;
  load(job: CaptureJob): Promise<MediaAsset | undefined>;
  read(asset: MediaAsset): Promise<{ bytes: Buffer; mediaType: string } | undefined>;
  put(asset: MediaAsset, media: DownloadedMedia): Promise<void>;
  finish(job: CaptureJob, evidence: MediaEvidence | null, errorCode?: string): Promise<boolean>;
}
export function createMediaStore(client: SupabaseClient, maxBytes: number): MediaStore {
  const bucket = client.storage.from("capture-assets");
  const store: MediaStore = {
    async claim() {
      const { data, error } = await client.rpc("claim_media_job");
      if (error) throw new MediaError("media_unavailable");
      const row = data?.[0];
      return row ? { id: row.id, captureId: row.capture_id, assetId: row.asset_id,
        jobType: "media_download", attempts: row.attempts } : undefined;
    },
    async load(job) {
      const { data, error } = await client.from("capture_assets").select("id, capture_id, storage_path, media_type, metadata")
        .eq("id", job.assetId).eq("capture_id", job.captureId).maybeSingle();
      if (error) throw new MediaError("media_unavailable");
      if (!data) return undefined;
      return { id: data.id, captureId: data.capture_id, storagePath: data.storage_path,
        mediaType: data.media_type, providerUrl: typeof data.metadata.url === "string" ? data.metadata.url : "" };
    },
    async read(asset) {
      const { data, error } = await bucket.download(asset.storagePath);
      if (error) {
        if (error.message === "Object not found" || ("statusCode" in error && String(error.statusCode) === "404")) return undefined;
        throw new MediaError("media_unavailable");
      }
      if (data.size > maxBytes) throw new MediaError("media_too_large");
      return { bytes: Buffer.from(await data.arrayBuffer()), mediaType: data.type };
    },
    async put(asset, media) {
      const { error } = await bucket.upload(asset.storagePath, media.bytes, { contentType: media.mediaType, upsert: false });
      if (!error) return;
      if (!("statusCode" in error) || !["409", "400"].includes(String(error.statusCode))) throw new MediaError("media_unavailable");
      // A crash after upload can leave an object but no DB receipt. Never overwrite it.
      const existing = await store.read(asset);
      if (!existing) throw new MediaError("media_unavailable");
      const checked = validateMedia(existing.bytes, existing.mediaType, asset.mediaType, maxBytes);
      if (checked.sha256 !== media.sha256) throw new MediaError("storage_conflict");
    },
    async finish(job, evidence, errorCode) {
      const { data, error } = await client.rpc("finish_media_attempt", {
        p_job_id: job.id, p_attempt: job.attempts, p_evidence: evidence, p_error_code: errorCode ?? null,
      });
      if (error) throw new MediaError("media_unavailable");
      return data === true;
    },
  };
  return store;
}
