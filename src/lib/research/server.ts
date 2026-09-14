import "server-only";

import { createUserScopedClient } from "../supabase/server";
import { authenticateResearchRequest } from "./access";
import type { ResearchDependencies } from "./handler";
import { createSupabaseResearchStore, type ResearchTableClient } from "./supabase-store";
import type { ResearchSession } from "./types";

/**
 * Wire the research handlers to Supabase.
 *
 * Two properties are deliberate. The token is verified by asking the auth provider who it
 * belongs to, so a forged or expired one fails here rather than downstream; and the store is
 * built per request from that same token, so every query the console makes is one the evaluator
 * could have made themselves.
 */
export function createResearchDependencies(): ResearchDependencies {
  return {
    authenticate: (request) =>
      authenticateResearchRequest(request, {
        researchUserId: process.env.RESEARCH_USER_ID ?? "",
        resolveUser: async (accessToken) => {
          const { data, error } = await createUserScopedClient(accessToken).auth.getUser(
            accessToken,
          );

          return error ? undefined : data.user?.id;
        },
      }),
    storeFor: (session: ResearchSession) =>
      createSupabaseResearchStore(
        createUserScopedClient(session.accessToken) as unknown as ResearchTableClient,
        session.userId,
      ),
  };
}
