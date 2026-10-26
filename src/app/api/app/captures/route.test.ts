import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabase = vi.hoisted(() => ({ createServiceRoleClient: vi.fn(), createUserScopedClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/supabase/server", () => supabase);
// Resolve the application's aliases locally without changing shared test configuration.
vi.mock("@/lib/capture/app-share", () => import("../../../../lib/capture/app-share"));
vi.mock("@/lib/capture/app-share-server", () => import("../../../../lib/capture/app-share-server"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const TOKENS: Record<string, string> = { "owner-token": OWNER, "stranger-token": STRANGER };

interface RpcArguments {
  p_user_id: string;
  p_capture_channel: string;
  p_external_message_id: string | null;
  p_capture_kind: string;
  p_raw_text: string | null;
  p_user_note: string | null;
  p_captured_at: string;
  p_raw_payload: unknown;
  p_assets: unknown[];
}

/** The RPC's contract in memory: one capture and one intent job, unique per (user, channel, id). */
class MemoryDatabase {
  captures: Array<{ id: string; input: RpcArguments }> = [];
  jobs: Array<{ id: string; captureId: string }> = [];
  fail = false;

  async rpc(name: string, input: RpcArguments) {
    expect(name).toBe("persist_capture_with_intent_job");
    if (this.fail) return { data: null, error: { message: "database unavailable" } };
    const existing = this.captures.find(({ input: saved }) =>
      saved.p_user_id === input.p_user_id &&
      saved.p_capture_channel === input.p_capture_channel &&
      saved.p_external_message_id === input.p_external_message_id);
    if (existing) {
      const job = this.jobs.find(({ captureId }) => captureId === existing.id)!;
      return { data: [{ capture_id: existing.id, intent_job_id: job.id, created: false }], error: null };
    }
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.captures.length + 1).padStart(12, "0")}`;
    this.captures.push({ id, input: structuredClone(input) });
    this.jobs.push({ id: `job-${this.jobs.length + 1}`, captureId: id });
    return { data: [{ capture_id: id, intent_job_id: `job-${this.jobs.length}`, created: true }], error: null };
  }
}

let database: MemoryDatabase;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("RESEARCH_USER_ID", OWNER);
  database = new MemoryDatabase();
  supabase.createServiceRoleClient.mockImplementation(() => database);
  supabase.createUserScopedClient.mockImplementation(() => ({
    auth: {
      getUser: async (token: string) => TOKENS[token]
        ? { data: { user: { id: TOKENS[token] } }, error: null }
        : { data: { user: null }, error: { message: "invalid JWT" } },
    },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(body: unknown, token: string | null = "owner-token", raw?: string): Request {
  return new Request("https://test.invalid/api/app/captures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: raw ?? JSON.stringify(body),
  });
}

async function send(request: Request): Promise<Response> {
  const { POST } = await import("./route");
  return POST(request);
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Authorization");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("POST /api/app/captures", () => {
  it("AC1 saves a shared url as one ios_share capture owned by the session user, with an intent job", async () => {
    const url = "https://example.test/article?id=1";
    const response = await send(post({ requestId: REQUEST_ID, url, sharedAt: "2026-10-26T08:00:00Z" }));

    expect(response.status).toBe(201);
    expectPrivate(response);
    expect(database.captures).toHaveLength(1);
    const [{ id, input }] = database.captures;
    expect(await response.json()).toEqual({ captureId: id, repeated: false });
    expect(database.jobs).toEqual([{ id: "job-1", captureId: id }]);
    expect(input).toMatchObject({
      p_user_id: OWNER,
      p_capture_channel: "ios_share",
      p_external_message_id: REQUEST_ID,
      p_capture_kind: "link",
      p_raw_text: url,
      p_user_note: null,
      p_assets: [],
      p_raw_payload: { requestId: REQUEST_ID, url, sharedAt: "2026-10-26T08:00:00Z" },
    });
    expect(input.p_captured_at).not.toBe("2026-10-26T08:00:00Z");
    expect(Number.isNaN(Date.parse(input.p_captured_at))).toBe(false);
  });

  it("AC1 derives text and mixed kinds and keeps the note with the normaliser's joining", async () => {
    await send(post({ requestId: REQUEST_ID, text: "a thought to keep" }));
    const mixedId = "44444444-4444-4444-8444-444444444444";
    await send(post({ requestId: mixedId, url: "https://example.test/x", text: "read this", note: "for Sunday" }));

    expect(database.captures.map(({ input }) => [input.p_capture_kind, input.p_raw_text, input.p_user_note])).toEqual([
      ["text", "a thought to keep", null],
      ["mixed", "https://example.test/x\nread this", "for Sunday"],
    ]);
  });

  it("AC2 a retry with the same requestId returns the same capture as repeated and saves nothing new", async () => {
    const first = await send(post({ requestId: REQUEST_ID, url: "https://example.test/a" }));
    const { captureId } = await first.json();
    const retry = await send(post({ requestId: REQUEST_ID, url: "https://example.test/a" }));

    expect(retry.status).toBe(200);
    expectPrivate(retry);
    expect(await retry.json()).toEqual({ captureId, repeated: true });
    expect(database.captures).toHaveLength(1);
    expect(database.jobs).toHaveLength(1);
  });

  it.each([
    ["userId", { userId: STRANGER }],
    ["user_id", { user_id: STRANGER }],
    ["an unknown key", { channel: "whatsapp" }],
  ])("AC3 a body with %s is rejected with 400 and nothing is persisted", async (_label, extra) => {
    const response = await send(post({ requestId: REQUEST_ID, url: "https://example.test/a", ...extra }));

    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "Invalid" });
    expect(database.captures).toHaveLength(0);
  });

  it.each([
    ["no token", null],
    ["an invalid token", "forged-token"],
    ["a valid token for another user", "stranger-token"],
  ])("AC4 %s is refused with 401 and nothing is persisted", async (_label, token) => {
    const response = await send(post({ requestId: REQUEST_ID, url: "https://example.test/a" }, token));

    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(database.captures).toHaveLength(0);
    expect(supabase.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("AC4 refuses everyone when RESEARCH_USER_ID is unset", async () => {
    vi.stubEnv("RESEARCH_USER_ID", "");
    const response = await send(post({ requestId: REQUEST_ID, url: "https://example.test/a" }));

    expect(response.status).toBe(401);
    expect(database.captures).toHaveLength(0);
  });

  it.each([
    ["neither url nor text", { requestId: REQUEST_ID, note: "only a note" }],
    ["whitespace-only text", { requestId: REQUEST_ID, text: "   " }],
    ["a non-http(s) url", { requestId: REQUEST_ID, url: "javascript:alert(1)" }],
    ["a relative url", { requestId: REQUEST_ID, url: "/article" }],
    ["an oversize url", { requestId: REQUEST_ID, url: `https://example.test/${"a".repeat(2000)}` }],
    ["an oversize text", { requestId: REQUEST_ID, text: "a".repeat(16001) }],
    ["an oversize note", { requestId: REQUEST_ID, text: "t", note: "a".repeat(16001) }],
    ["a missing requestId", { url: "https://example.test/a" }],
    ["a non-uuid requestId", { requestId: "retry-1", url: "https://example.test/a" }],
    ["a non-string text", { requestId: REQUEST_ID, text: 42 }],
    ["a malformed sharedAt", { requestId: REQUEST_ID, text: "t", sharedAt: "yesterday" }],
    ["an array body", [{ requestId: REQUEST_ID, text: "t" }]],
    ["a null body", null],
  ])("AC5 %s is rejected with 400", async (_label, body) => {
    const response = await send(post(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid" });
    expect(database.captures).toHaveLength(0);
  });

  it("AC5 accepts fields at their limits", async () => {
    const url = `https://example.test/${"a".repeat(2000 - "https://example.test/".length)}`;
    const response = await send(post({ requestId: REQUEST_ID, url, text: "a".repeat(16000), note: "n".repeat(16000) }));

    expect(response.status).toBe(201);
  });

  it("AC5 a body over 64 KiB or not JSON is rejected with 400", async () => {
    const padded = JSON.stringify({ requestId: REQUEST_ID, text: "t", note: "n" }).replace('"n"', `"${" ".repeat(64 * 1024)}"`);
    const oversize = await send(post(undefined, "owner-token", padded));
    const malformed = await send(post(undefined, "owner-token", "{not json"));
    const streamed = await send(new Request("https://test.invalid/api/app/captures", {
      method: "POST",
      headers: { authorization: "Bearer owner-token" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"requestId":"${REQUEST_ID}","text":"`));
          controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit));

    expect([oversize.status, malformed.status, streamed.status]).toEqual([400, 400, 400]);
    expect(database.captures).toHaveLength(0);
  });

  it("AC6 a persistence failure is 503 with private headers and no submitted content echoed", async () => {
    database.fail = true;
    const response = await send(post({ requestId: REQUEST_ID, url: "https://example.test/secret-path", note: "private note" }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(JSON.parse(text)).toEqual({ error: "Unavailable" });
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("private note");
    expect(text).not.toContain("database unavailable");
  });

  it("AC6 an unconfigured service-role client is 503 rather than a crash", async () => {
    supabase.createServiceRoleClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
    });
    const response = await send(post({ requestId: REQUEST_ID, text: "keep" }));

    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "Unavailable" });
  });
});
