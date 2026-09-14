import type { ResearchSession } from "./types";

export interface ResearchAccessPolicy {
  /**
   * The single user id permitted to use the research console in v0. An empty value disables
   * the console entirely rather than admitting anyone who happens to hold a valid session.
   */
  researchUserId: string;
  /**
   * Resolve a presented access token to the user id the auth provider says it belongs to, or
   * undefined. The server must do this itself: a user id sent by the browser is a claim.
   */
  resolveUser(accessToken: string): Promise<string | undefined>;
}

function presentedToken(request: Request): string {
  const match = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "");

  return match?.[1]?.trim() ?? "";
}

/**
 * Verify the caller, or return undefined. There is exactly one success path and it requires
 * both a token the auth provider vouches for and a match against the configured research user.
 * Everything else — no header, an unknown token, a valid session belonging to somebody else —
 * returns the same undefined, so a caller cannot tell the cases apart.
 */
export async function authenticateResearchRequest(
  request: Request,
  policy: ResearchAccessPolicy,
): Promise<ResearchSession | undefined> {
  if (policy.researchUserId.trim().length === 0) {
    return undefined;
  }

  const accessToken = presentedToken(request);

  if (accessToken.length === 0) {
    return undefined;
  }

  const userId = await policy.resolveUser(accessToken);

  if (!userId || userId !== policy.researchUserId) {
    return undefined;
  }

  return { userId, accessToken };
}
