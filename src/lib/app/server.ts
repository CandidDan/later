import "server-only";
import { authenticateResearchRequest } from "../research/access";
import { createUserScopedClient } from "../supabase/server";
import { createAppStore } from "./store";
import type { AppDependencies } from "./handler";
export function createAppDependencies(): AppDependencies {
  return {
    authenticate: request => authenticateResearchRequest(request, {
      researchUserId: process.env.RESEARCH_USER_ID ?? "",
      resolveUser: async token => {
        const { data, error } = await createUserScopedClient(token).auth.getUser(token);
        return error ? undefined : data.user?.id;
      },
    }),
    storeFor: session => createAppStore(createUserScopedClient(session.accessToken), session.userId),
  };
}
