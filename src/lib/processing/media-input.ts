import type { CaptureAssetRecord, CaptureRecord } from "../jobs/types";
import { digest, isImageType, MediaError, type ImageMediaType } from "../assets/media";
import { buildIntentInputSnapshot, type IntentInputSnapshot } from "./intent-input";
export interface IntentImage { assetId: string; mediaType: ImageMediaType; data: string }
export type ReadPrivateImage = (asset: CaptureAssetRecord) => Promise<Buffer>;
export interface EnrichedInput { snapshot: IntentInputSnapshot; images: IntentImage[] }

export async function buildEnrichedIntentInput(capture: CaptureRecord, read: ReadPrivateImage): Promise<EnrichedInput> {
  const snapshot = buildIntentInputSnapshot(capture);
  snapshot.analysisPhase = "enriched";
  const images: Promise<IntentImage>[] = [];
  let total = 0;
  snapshot.assets = [];
  for (const asset of capture.assets) {
    let contentAnalysis = "metadata_only";
    const type = asset.observedMediaType;
    if (asset.storageState === "stored" && type && isImageType(type) && asset.id && asset.sha256 && asset.storedByteSize) {
      if (asset.storedByteSize <= 5 * 1024 * 1024 && total + asset.storedByteSize <= 20 * 1024 * 1024 && images.length < 20) {
        const assetId = asset.id;
        images.push(read(asset).then((bytes) => {
          if (bytes.length !== asset.storedByteSize || digest(bytes) !== asset.sha256) throw new MediaError("storage_conflict");
          return { assetId, mediaType: type, data: bytes.toString("base64") };
        }));
        total += asset.storedByteSize;
        contentAnalysis = "image";
      } else contentAnalysis = "metadata_only_size_limit";
    }
    snapshot.assets.push({ assetId: asset.id ?? null, filename: asset.filename,
      storageState: asset.storageState ?? "pending", mediaType: type ?? asset.mediaType,
      byteSize: asset.storedByteSize ?? asset.byteSize, sha256: asset.sha256 ?? null, contentAnalysis });
  }
  return { snapshot, images: await Promise.all(images) };
}
