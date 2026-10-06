interface SessionResult {
  data: {
    session: { access_token: string } | null;
  };
}

interface MagicLinkResult {
  error: unknown;
}

export interface ResearchAuthClient {
  getSession(): Promise<SessionResult>;
  signInWithOtp(credentials: {
    email: string;
    options: {
      emailRedirectTo: string;
      shouldCreateUser: false;
    };
  }): Promise<MagicLinkResult>;
}

export const MAGIC_LINK_FAILURE_MESSAGE = "We couldn't send a sign-in link. Please try again.";

export async function restoreResearchAccessToken(
  auth: Pick<ResearchAuthClient, "getSession">,
): Promise<string | null> {
  const { data } = await auth.getSession();

  return data.session?.access_token ?? null;
}

/**
 * Ask Supabase to deliver the link without returning any provider detail to the console. The
 * current browser origin is intentionally supplied by the caller so preview and production
 * deployments cannot silently redirect into one another.
 */
export async function requestResearchMagicLink(
  auth: Pick<ResearchAuthClient, "signInWithOtp">,
  email: string,
  origin: string,
  returnPath: "/research" | "/revisit" = "/research",
): Promise<boolean> {
  try {
    const { error } = await auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: new URL(returnPath, origin).toString(),
        shouldCreateUser: false,
      },
    });

    return !error;
  } catch {
    return false;
  }
}
