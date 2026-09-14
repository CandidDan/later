import { describe, expect, it, vi } from "vitest";

import { authenticateResearchRequest } from "./access";

const RESEARCH_USER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

function request(authorization?: string): Request {
  return new Request("https://test.invalid/api/research/next", {
    headers: authorization ? { authorization } : {},
  });
}

describe("research access", () => {
  it("AC1 admits only a verified token belonging to the configured research user", async () => {
    const resolveUser = vi.fn(async () => RESEARCH_USER);

    await expect(
      authenticateResearchRequest(request("Bearer TEST-ONLY-NOT-A-CREDENTIAL"), {
        researchUserId: RESEARCH_USER,
        resolveUser,
      }),
    ).resolves.toEqual({ userId: RESEARCH_USER, accessToken: "TEST-ONLY-NOT-A-CREDENTIAL" });
    expect(resolveUser).toHaveBeenCalledExactlyOnceWith("TEST-ONLY-NOT-A-CREDENTIAL");
  });

  it.each([
    ["no authorization header", undefined, RESEARCH_USER],
    ["a non-bearer header", "Basic dXNlcjpwYXNz", RESEARCH_USER],
    ["an empty bearer value", "Bearer    ", RESEARCH_USER],
  ])("AC1 rejects %s without asking the auth provider", async (_name, header, userId) => {
    const resolveUser = vi.fn(async () => userId);

    await expect(
      authenticateResearchRequest(request(header), { researchUserId: RESEARCH_USER, resolveUser }),
    ).resolves.toBeUndefined();
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("AC1 rejects a valid session belonging to another user", async () => {
    await expect(
      authenticateResearchRequest(request("Bearer TEST-ONLY-NOT-A-CREDENTIAL"), {
        researchUserId: RESEARCH_USER,
        resolveUser: async () => STRANGER,
      }),
    ).resolves.toBeUndefined();
  });

  it("AC1 rejects a token the auth provider cannot vouch for", async () => {
    await expect(
      authenticateResearchRequest(request("Bearer TEST-ONLY-NOT-A-CREDENTIAL"), {
        researchUserId: RESEARCH_USER,
        resolveUser: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("AC1 admits nobody while the console is unconfigured", async () => {
    const resolveUser = vi.fn(async () => RESEARCH_USER);

    await expect(
      authenticateResearchRequest(request("Bearer TEST-ONLY-NOT-A-CREDENTIAL"), {
        researchUserId: "   ",
        resolveUser,
      }),
    ).resolves.toBeUndefined();
    expect(resolveUser).not.toHaveBeenCalled();
  });
});
