import type { SupabaseClient } from "@supabase/supabase-js";

import { createMediaStore } from "../assets/store";
import type { DownloadedMedia, MediaEvidence } from "../assets/media";
import { EmailError } from "./config";
import { ATTACHMENT_ROLE, REPRESENTATION_ROLE } from "./event";

export interface EmailEnrichmentJob {
  id: string;
  captureId: string;
  attempts: number;
}

export interface EmailAsset {
  id: string;
  captureId: string;
  storagePath: string;
  role: string;
  providerAttachmentId: string | null;
  mediaType: string | null;
  storageState: string;
}

export interface EmailEnrichmentStore {
  claim(): Promise<EmailEnrichmentJob | undefined>;
  loadEmailId(captureId: string): Promise<string | undefined>;
  loadAssets(captureId: string): Promise<EmailAsset[]>;
  read(asset: EmailAsset): Promise<{ bytes: Buffer; mediaType: string } | undefined>;
  put(asset: EmailAsset, media: DownloadedMedia): Promise<void>;
  finishAsset(
    job: EmailEnrichmentJob,
    asset: EmailAsset,
    evidence: MediaEvidence | null,
    errorCode?: string,
  ): Promise<boolean>;
  finish(job: EmailEnrichmentJob, errorCode?: string): Promise<boolean>;
}

function assetRole(metadata: unknown): string {
  const role =
    metadata !== null && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).role
      : undefined;

  return role === REPRESENTATION_ROLE || role === ATTACHMENT_ROLE ? role : "unknown";
}

function providerAttachmentId(metadata: unknown): string | null {
  const id =
    metadata !== null && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).id
      : undefined;

  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The email enrichment job's whole database surface. Object bytes reuse the media store built
 * for later-0007 — same private bucket, same read-before-write reconciliation — so an email
 * attachment and a WhatsApp image are stored by exactly one code path.
 */
export function createEmailEnrichmentStore(
  client: SupabaseClient,
  maxBytes: number,
): EmailEnrichmentStore {
  const objects = createMediaStore(client, maxBytes);
  const asMediaAsset = (asset: EmailAsset) => ({
    id: asset.id,
    captureId: asset.captureId,
    storagePath: asset.storagePath,
    providerUrl: "",
    mediaType: asset.mediaType,
  });

  return {
    async claim() {
      const { data, error } = await client.rpc("claim_email_enrichment_job");
      if (error) throw new EmailError("email_unavailable");

      const row = data?.[0];
      return row ? { id: row.id, captureId: row.capture_id, attempts: row.attempts } : undefined;
    },

    async loadEmailId(captureId) {
      const { data, error } = await client
        .from("captures")
        .select("external_message_id")
        .eq("id", captureId)
        .eq("capture_channel", "email")
        .maybeSingle();
      if (error) throw new EmailError("email_unavailable");

      return typeof data?.external_message_id === "string" ? data.external_message_id : undefined;
    },

    async loadAssets(captureId) {
      const { data, error } = await client
        .from("capture_assets")
        .select("id, capture_id, storage_path, media_type, storage_state, metadata")
        .eq("capture_id", captureId)
        .order("created_at", { ascending: true });
      if (error) throw new EmailError("email_unavailable");

      return (data ?? []).map((row) => ({
        id: row.id,
        captureId: row.capture_id,
        storagePath: row.storage_path,
        mediaType: row.media_type,
        storageState: row.storage_state,
        role: assetRole(row.metadata),
        providerAttachmentId: providerAttachmentId(row.metadata),
      }));
    },

    read: (asset) => objects.read(asMediaAsset(asset)),
    put: (asset, media) => objects.put(asMediaAsset(asset), media),

    async finishAsset(job, asset, evidence, errorCode) {
      const { data, error } = await client.rpc("finish_email_asset", {
        p_job_id: job.id,
        p_attempt: job.attempts,
        p_asset_id: asset.id,
        p_evidence: evidence,
        p_error_code: errorCode ?? null,
      });
      if (error) throw new EmailError("email_unavailable");

      return data === true;
    },

    async finish(job, errorCode) {
      const { data, error } = await client.rpc("finish_email_enrichment_attempt", {
        p_job_id: job.id,
        p_attempt: job.attempts,
        p_error_code: errorCode ?? null,
      });
      if (error) throw new EmailError("email_unavailable");

      return data === true;
    },
  };
}
