import { MediaError, validateMedia } from "../assets/media";
import { EmailError, type EmailRetrievalConfiguration } from "./config";
import { ATTACHMENT_ROLE, REPRESENTATION_MEDIA_TYPE, REPRESENTATION_ROLE } from "./event";
import {
  buildStoredRepresentation,
  serializeRepresentation,
} from "./representation";
import {
  downloadAttachment,
  listReceivedEmailAttachments,
  retrieveReceivedEmail,
} from "./resend";
import type { EmailAsset, EmailEnrichmentJob, EmailEnrichmentStore } from "./store";

export type EmailEnrichmentOutcome =
  | { status: "idle" }
  | { status: "succeeded" | "failed"; jobId: string; captureId: string };

/**
 * Failures that describe the input rather than the weather. These are recorded as-is and are
 * terminal for the thing they describe; everything else collapses to `email_unavailable` and is
 * retried, so provider-controlled text can never reach a `last_error` or `storage_error` column.
 */
const TERMINAL_CODES = new Set([
  "unsafe_origin",
  "unsafe_redirect",
  "unsafe_media",
  "media_mismatch",
  "media_too_large",
  "media_missing",
  "email_too_large",
  "email_missing",
  "email_response_invalid",
  "email_configuration_invalid",
  "storage_conflict",
  "attachment_missing",
  "capture_missing",
]);

function safeCode(error: unknown): string {
  const code = error instanceof EmailError || error instanceof MediaError ? error.code : undefined;

  return code !== undefined && TERMINAL_CODES.has(code) ? code : "email_unavailable";
}

/** A transient code must fail the whole attempt so the job's retry policy — not this loop — owns it. */
function isTerminal(code: string): boolean {
  return TERMINAL_CODES.has(code);
}

async function storeRepresentation(
  store: EmailEnrichmentStore,
  job: EmailEnrichmentJob,
  asset: EmailAsset,
  emailId: string,
  config: EmailRetrievalConfiguration,
  fetcher: typeof fetch,
  now: () => Date,
): Promise<void> {
  const response = await retrieveReceivedEmail(emailId, config, fetcher);
  const bytes = serializeRepresentation(
    buildStoredRepresentation(emailId, response, now().toISOString()),
  );

  if (bytes.length > config.maxBytes) throw new EmailError("email_too_large");

  const media = validateMedia(bytes, REPRESENTATION_MEDIA_TYPE, REPRESENTATION_MEDIA_TYPE, config.maxBytes);
  // A crashed attempt can leave the object committed with no database receipt.
  if (!(await store.read(asset))) await store.put(asset, media);

  await store.finishAsset(job, asset, {
    mediaType: media.mediaType,
    byteSize: media.byteSize,
    sha256: media.sha256,
  });
}

/**
 * Claim one pending `email_enrichment` job and give the capture its full body and attachments.
 *
 * The parsed representation is stored first: it is the provenance every later analysis cites, so
 * a run that loses one attachment still has a complete, addressable email behind it. Attachments
 * then succeed or fail one at a time — an unsafe or missing attachment is that asset's terminal
 * state, not the email's, while a transient failure aborts the attempt and leaves the job to the
 * retry policy. Nothing here rewrites the capture or an earlier analysis.
 */
export async function processNextEmailEnrichmentJob(
  store: EmailEnrichmentStore,
  config: EmailRetrievalConfiguration,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<EmailEnrichmentOutcome> {
  const job = await store.claim();
  if (!job) return { status: "idle" };

  const identity = { jobId: job.id, captureId: job.captureId };

  try {
    const emailId = await store.loadEmailId(job.captureId);
    if (!emailId) throw new EmailError("capture_missing");

    const assets = await store.loadAssets(job.captureId);
    const representation = assets.find((asset) => asset.role === REPRESENTATION_ROLE);
    if (!representation) throw new EmailError("capture_missing");

    if (representation.storageState === "pending") {
      await storeRepresentation(store, job, representation, emailId, config, fetcher, now);
    }

    const pending = assets.filter(
      (asset) => asset.role === ATTACHMENT_ROLE && asset.storageState === "pending",
    );

    if (pending.length > 0) {
      const downloads = await listReceivedEmailAttachments(emailId, config, fetcher);

      for (const asset of pending) {
        const download = downloads.find((entry) => entry.id === asset.providerAttachmentId);

        if (!download) {
          await store.finishAsset(job, asset, null, "attachment_missing");
          continue;
        }

        try {
          const existing = await store.read(asset);
          const media = existing
            ? validateMedia(existing.bytes, existing.mediaType, asset.mediaType, config.maxBytes)
            : await downloadAttachment(download.downloadUrl, asset.mediaType, config.maxBytes, fetcher);
          if (!existing) await store.put(asset, media);

          await store.finishAsset(job, asset, {
            mediaType: media.mediaType,
            byteSize: media.byteSize,
            sha256: media.sha256,
          });
        } catch (error) {
          const code = safeCode(error);
          if (!isTerminal(code)) throw error;
          await store.finishAsset(job, asset, null, code);
        }
      }
    }

    const finished = await store.finish(job);
    return { ...identity, status: finished ? "succeeded" : "failed" };
  } catch (error) {
    await store.finish(job, safeCode(error));
    return { ...identity, status: "failed" };
  }
}
