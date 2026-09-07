import "server-only";
import { createClient } from "@supabase/supabase-js";
import { configuredMedia, MediaError } from "./media";
import { createMediaStore } from "./store";
import { processNextMediaJob } from "./process";
import type { ReadPrivateImage } from "../processing/media-input";
function mediaClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new MediaError("media_configuration_invalid");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) } });
}
export function createMediaProcessor() {
  const config = configuredMedia();
  const store = createMediaStore(mediaClient(), config.maxBytes);
  return () => processNextMediaJob(store, config);
}
export function createPrivateImageReader(): ReadPrivateImage {
  const store = createMediaStore(mediaClient(), 5 * 1024 * 1024);
  return async (asset) => {
    if (!asset.id || !asset.storagePath) throw new MediaError("media_missing");
    const object = await store.read({ id: asset.id, storagePath: asset.storagePath,
      captureId: "", providerUrl: "", mediaType: asset.observedMediaType ?? null });
    if (!object) throw new MediaError("media_missing");
    return object.bytes;
  };
}
