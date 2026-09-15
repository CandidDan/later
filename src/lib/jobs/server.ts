import "server-only";

import { createServiceRoleClient } from "../supabase/server";
import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";
import type { SegmentResolutionJobStore } from "./types";

export function createCaptureJobStore(): SegmentResolutionJobStore {
  return createSupabaseCaptureJobStore(
    createServiceRoleClient() as unknown as CaptureJobTableClient,
  );
}
