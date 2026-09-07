import { downloadTwilioMedia, MediaError, validateMedia, type MediaConfiguration } from "./media";
import type { MediaStore } from "./store";
export type MediaOutcome = { status: "idle" } | { status: "succeeded" | "failed"; jobId: string; captureId: string };
const SAFE_CODES = new Set(["unsafe_origin", "unsafe_redirect", "media_too_large", "media_mismatch", "unsafe_media", "media_missing", "storage_conflict"]);
export async function processNextMediaJob(store: MediaStore, config: MediaConfiguration, fetcher: typeof fetch = fetch): Promise<MediaOutcome> {
  const job = await store.claim();
  if (!job) return { status: "idle" };
  const identity = { jobId: job.id, captureId: job.captureId };
  try {
    const asset = await store.load(job);
    if (!asset) throw new MediaError("media_missing");
    // Reconcile an upload that succeeded before a crashed worker could finalize its receipt.
    const existing = await store.read(asset);
    const media = existing ? validateMedia(existing.bytes, existing.mediaType, asset.mediaType, config.maxBytes)
      : await downloadTwilioMedia(asset.providerUrl, asset.mediaType, config, fetcher);
    if (!existing) await store.put(asset, media);
    const { mediaType, byteSize, sha256 } = media;
    const finished = await store.finish(job, { mediaType, byteSize, sha256 });
    return { ...identity, status: finished ? "succeeded" : "failed" };
  } catch (error) {
    const code = error instanceof MediaError && SAFE_CODES.has(error.code) ? error.code : "media_unavailable";
    await store.finish(job, null, code);
    return { ...identity, status: "failed" };
  }
}
