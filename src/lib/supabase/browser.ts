"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase client. It carries the public anon key only — the service-role key is
 * confined to `server.ts`, which is marked `server-only` so importing it here would fail the
 * build rather than ship a credential to a page.
 */
let client: SupabaseClient | undefined;

export function browserSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  }

  client ??= createClient(url, anonKey);

  return client;
}
