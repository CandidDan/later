import "server-only";

import { createServiceRoleClient } from "../supabase/server";
import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";
import type { ArticleExtractionJobStore } from "./types";

export function createCaptureJobStore(): ArticleExtractionJobStore {
  return createSupabaseCaptureJobStore(
    createServiceRoleClient() as unknown as CaptureJobTableClient,
  );
}
