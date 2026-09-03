import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requiredEnvironmentVariable(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for server-side capture persistence`);
  }

  return value;
}

export function createServiceRoleClient(): SupabaseClient {
  return createClient(
    requiredEnvironmentVariable("SUPABASE_URL"),
    requiredEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
