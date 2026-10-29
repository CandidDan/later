import "server-only";
import { authenticateResearchRequest } from "../research/access";
import { createUserScopedClient } from "../supabase/server";
import type { AppShareDependencies } from "./app-share";
import { persistCapture } from "./persist";
export function createAppShareDependencies(): AppShareDependencies {
  return {
    authenticate: request => authenticateResearchRequest(request, {
      researchUserId: process.env.RESEARCH_USER_ID ?? "",
      resolveUser: async token => {
        const { data, error } = await createUserScopedClient(token).auth.getUser(token);
        return error ? undefined : data.user?.id;
      },
    }),
    persist: input => persistCapture(input),
  };
}
