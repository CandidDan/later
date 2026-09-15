import "server-only";

import { createServiceRoleClient } from "../supabase/server";
import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";
import type { SourceResolutionJobStore } from "./types";

export function createCaptureJobStore(): SourceResolutionJobStore {
  return createSupabaseCaptureJobStore(
    createServiceRoleClient() as unknown as CaptureJobTableClient,
  );
}
