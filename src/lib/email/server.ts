import "server-only";

import { createClient } from "@supabase/supabase-js";

import { EmailError, configuredEmailRetrieval } from "./config";
import { processNextEmailEnrichmentJob } from "./enrich";
import { createEmailEnrichmentStore } from "./store";

function emailClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new EmailError("email_configuration_invalid");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) } });
}

export function createEmailEnrichmentProcessor() {
  const config = configuredEmailRetrieval();
  const store = createEmailEnrichmentStore(emailClient(), config.maxBytes);
  return () => processNextEmailEnrichmentJob(store, config);
}
