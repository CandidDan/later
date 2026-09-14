import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type PrivilegedVariable = "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY";
type PublicVariable = "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY";

function requiredEnvironmentVariable(name: PrivilegedVariable | PublicVariable): string {
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

/**
 * A client that acts as the signed-in user, built from the public key and their access token.
 *
 * The research console reads and writes captures through this, never through the service-role
 * client: that keeps row-level security as the thing actually separating one evaluator from
 * another's data, instead of application filters a future change could forget to apply.
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(
    requiredEnvironmentVariable("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnvironmentVariable("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  );
}
