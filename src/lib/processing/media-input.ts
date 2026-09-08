import type { CaptureAssetRecord, CaptureRecord, JsonValue } from "../jobs/types";
import { digest, isImageType, MediaError, type ImageMediaType } from "../assets/media";
import { REPRESENTATION_MODEL_READ_LIMIT } from "../email/config";
import { REPRESENTATION_ROLE } from "../email/event";
import { parseStoredRepresentation, representationExcerpt } from "../email/representation";
import { buildIntentInputSnapshot, type IntentInputSnapshot } from "./intent-input";
export interface IntentImage { assetId: string; mediaType: ImageMediaType; data: string }
export type ReadPrivateImage = (asset: CaptureAssetRecord) => Promise<Buffer>;
export interface EnrichedInput { snapshot: IntentInputSnapshot; images: IntentImage[] }

/** The parsed-email asset is identified by the role recorded on it at capture time. */
function isRepresentation(asset: CaptureAssetRecord): boolean {
  return asset.filename === "email.json" || asset.role === REPRESENTATION_ROLE;
}

/**
 * Read the stored email back for the enriched run.
 *
 * The snapshot records where the content came from — asset id, digest, byte size — so an
 * analysis can always be traced to the exact stored object it was drawn from, and a later
 * reader can tell "the model saw the whole email" from "the model saw its subject line".
 * A read failure is not fatal: the run continues, metadata-only, and says so.
 */
async function emailRepresentation(
  capture: CaptureRecord,
  read: ReadPrivateImage,
): Promise<Record<string, JsonValue> | undefined> {
  const asset = capture.assets.find(isRepresentation);
  if (!asset) return undefined;

  const provenance = {
    assetId: asset.id ?? null,
    storageState: asset.storageState ?? "pending",
    sha256: asset.sha256 ?? null,
    byteSize: asset.storedByteSize ?? null,
  };

  if (asset.storageState !== "stored" || !asset.id || !asset.sha256 || !asset.storedByteSize) {
    return { ...provenance, contentAnalysis: "metadata_only" };
  }

  if (asset.storedByteSize > REPRESENTATION_MODEL_READ_LIMIT) {
    return { ...provenance, contentAnalysis: "metadata_only_size_limit" };
  }

  try {
    const bytes = await read(asset);
    if (bytes.length !== asset.storedByteSize || digest(bytes) !== asset.sha256) {
      throw new MediaError("storage_conflict");
    }

    const representation = parseStoredRepresentation(bytes);
    if (!representation) return { ...provenance, contentAnalysis: "metadata_only_unreadable" };

    return { ...provenance, contentAnalysis: "email", ...representationExcerpt(representation) };
  } catch {
    return { ...provenance, contentAnalysis: "metadata_only_unreadable" };
  }
}

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
    } else if (isRepresentation(asset)) contentAnalysis = "email_representation";
    snapshot.assets.push({ assetId: asset.id ?? null, filename: asset.filename,
      storageState: asset.storageState ?? "pending", mediaType: type ?? asset.mediaType,
      byteSize: asset.storedByteSize ?? asset.byteSize, sha256: asset.sha256 ?? null, contentAnalysis });
  }
  const email = await emailRepresentation(capture, read);
  if (email) snapshot.email = email;
  return { snapshot, images: await Promise.all(images) };
}
