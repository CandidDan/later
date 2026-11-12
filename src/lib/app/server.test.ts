import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createStore: vi.fn(), getUser: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../supabase/server", () => ({ createUserScopedClient: mocks.createClient }));
vi.mock("./store", () => ({ createAppStore: mocks.createStore }));
import { createAppDependencies } from "./server";
const owner = "11111111-1111-4111-8111-111111111111";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("app dependency authentication", () => {
  it.each(["missing", "invalid", "wrong-user", "disabled"])("rejects %s credentials and never creates a data store", async failure => {
    vi.stubEnv("RESEARCH_USER_ID", failure === "disabled" ? "" : owner);
    mocks.createClient.mockReturnValue({ auth: { getUser: mocks.getUser } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: failure === "wrong-user" ? "other" : owner } }, error: failure === "invalid" ? new Error("invalid") : null });
    const req = new Request("https://example.com/api/app/library", { headers: failure === "missing" ? {} : { Authorization: "Bearer token" } });
    expect(await createAppDependencies().authenticate(req)).toBeUndefined();
    expect(mocks.createStore).not.toHaveBeenCalled();
    if (["missing", "disabled"].includes(failure)) expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("verifies the bearer token and constructs only a caller-bound RLS client", async () => {
    vi.stubEnv("RESEARCH_USER_ID", owner);
    const client = { auth: { getUser: mocks.getUser } };
    mocks.createClient.mockReturnValue(client); mocks.getUser.mockResolvedValue({ data: { user: { id: owner } }, error: null });
    const deps = createAppDependencies();
    const session = await deps.authenticate(new Request("https://example.com/api/app/library", { headers: { Authorization: "Bearer owner-token" } }));
    expect(session).toEqual({ userId: owner, accessToken: "owner-token" });
    deps.storeFor(session!);
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith("owner-token");
    expect(mocks.createClient.mock.calls).toEqual([["owner-token"], ["owner-token"]]);
    expect(mocks.createStore).toHaveBeenCalledExactlyOnceWith(client, owner);
  });
});
