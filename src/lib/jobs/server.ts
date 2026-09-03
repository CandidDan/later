import "server-only";

import { createServiceRoleClient } from "../supabase/server";
import { createSupabaseCaptureJobStore, type CaptureJobTableClient } from "./supabase-store";
import type { CaptureJobStore } from "./types";

export function createCaptureJobStore(): CaptureJobStore {
  return createSupabaseCaptureJobStore(
    createServiceRoleClient() as unknown as CaptureJobTableClient,
  );
}
