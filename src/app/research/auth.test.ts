import { describe, expect, it, vi } from "vitest";

import { authenticateResearchRequest } from "../../lib/research/access";

import {
  MAGIC_LINK_FAILURE_MESSAGE,
  requestResearchMagicLink,
  restoreResearchAccessToken,
} from "./auth";

describe("later-0017 research magic-link authentication", () => {
  it("AC2 requests passwordless sign-in at the current deployment's research route without creating users", async () => {
    const signInWithOtp = vi.fn(async () => ({ error: null }));

    await expect(
      requestResearchMagicLink({ signInWithOtp }, "researcher@example.test", "https://preview.example.test"),
    ).resolves.toBe(true);
    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: "researcher@example.test",
      options: {
        emailRedirectTo: "https://preview.example.test/research",
        shouldCreateUser: false,
      },
    });
  });

  it("AC3 treats an accepted request as sent without requiring or returning a session", async () => {
    const signInWithOtp = vi.fn(async () => ({
      data: { session: null, user: null },
      error: null,
    }));

    await expect(
      requestResearchMagicLink({ signInWithOtp }, "unknown@example.test", "https://notfor.now"),
    ).resolves.toBe(true);
  });

  it.each([
    ["a provider rejection", async () => ({ error: new Error("User does not exist") })],
    ["a thrown provider failure", async () => Promise.reject(new Error("private provider detail"))],
  ])("AC4 reduces %s to the same generic failure outcome", async (_case, signInWithOtp) => {
    await expect(
      requestResearchMagicLink({ signInWithOtp }, "researcher@example.test", "https://notfor.now"),
    ).resolves.toBe(false);
    expect(MAGIC_LINK_FAILURE_MESSAGE).toBe("We couldn't send a sign-in link. Please try again.");
    expect(MAGIC_LINK_FAILURE_MESSAGE).not.toMatch(/user|account|provider|supabase/iu);
  });

  it("AC5 restores the existing bearer token when a visitor returns with a Supabase session", async () => {
    const getSession = vi.fn(async () => ({
      data: { session: { access_token: "TEST-ONLY-RESTORED-ACCESS-TOKEN" } },
    }));

    await expect(restoreResearchAccessToken({ getSession })).resolves.toBe(
      "TEST-ONLY-RESTORED-ACCESS-TOKEN",
    );
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("AC5 still denies a restored session whose user is not RESEARCH_USER_ID", async () => {
    const accessToken = await restoreResearchAccessToken({
      getSession: async () => ({
        data: { session: { access_token: "TEST-ONLY-STRANGER-ACCESS-TOKEN" } },
      }),
    });
    const resolveUser = vi.fn(async () => "22222222-2222-2222-2222-222222222222");

    await expect(
      authenticateResearchRequest(
        new Request("https://notfor.now/api/research/next", {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        {
          researchUserId: "11111111-1111-1111-1111-111111111111",
          resolveUser,
        },
      ),
    ).resolves.toBeUndefined();
    expect(resolveUser).toHaveBeenCalledExactlyOnceWith("TEST-ONLY-STRANGER-ACCESS-TOKEN");
  });
});

it("later-0020 AC1 returns magic-link authentication directly to revisit without research", async () => {
  const signInWithOtp = vi.fn(async () => ({ error: null }));
  expect(await requestResearchMagicLink({ signInWithOtp }, "owner@example.test", "https://notfor.now", "/revisit")).toBe(true);
  expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({ email: "owner@example.test", options: { emailRedirectTo: "https://notfor.now/revisit", shouldCreateUser: false } });
});
