import "server-only";
import { authenticateResearchRequest } from "../research/access";
import { createUserScopedClient } from "../supabase/server";
import { createRevisitStore } from "./store";
import type { RevisitDependencies } from "./handler";
export function createRevisitDependencies(): RevisitDependencies {
  return {
    authenticate: request => authenticateResearchRequest(request, {
      researchUserId: process.env.RESEARCH_USER_ID ?? "",
      resolveUser: async token => {
        const { data, error } = await createUserScopedClient(token).auth.getUser(token);
        return error ? undefined : data.user?.id;
      },
    }),
    storeFor: session => createRevisitStore(createUserScopedClient(session.accessToken), session.userId),
  };
}
