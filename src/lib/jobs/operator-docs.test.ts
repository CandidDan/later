import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { handleProcessJobsRequest } from "./handler";

const guide = readFileSync("README.md", "utf8").split("## Automatic intent processing")[1];

describe("intent operator guide", () => {
  it("AC6 identifies every Vault name, environment setting, verification query and lifecycle", () => {
    for (const name of ["later_jobs_process_url", "later_jobs_process_secret", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_INTENT_MODEL", "JOBS_PROCESS_SECRET", "JOBS_PROCESS_URL"]) expect(guide).toContain(name);
    for (const step of ["Vault interface", "supabase db push", "cron.job_run_details", "net._http_response", "public.capture_jobs", "available_at", "ten minutes", "terminal", "active := false"]) expect(guide.replace(/\s+/gu, " ")).toContain(step);
    const queries = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map(m => m[1]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join("\n")).not.toMatch(/decrypted_secret|select \*|headers|content|create_secret/iu);
  });

  it("AC6 documented manual recovery command authenticates and prints only counts", async () => {
    const secret = "TEST-ONLY-NOT-A-CREDENTIAL";
    const server = createServer(async (incoming, outgoing) => {
      const response = await handleProcessJobsRequest(new Request("http://localhost/api/jobs/process", { method: incoming.method, headers: { authorization: incoming.headers.authorization ?? "" } }), { secret, processNext: async () => ({ status: "idle" }) });
      outgoing.writeHead(response.status);
      outgoing.end(await response.text());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      const command = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].find(m => m[1].includes("curl"))?.[1];
      expect(command).toBeDefined();
      const { stdout, stderr } = await promisify(execFile)("bash", ["-c", command!], { env: { ...process.env, JOBS_PROCESS_SECRET: secret, JOBS_PROCESS_URL: `http://127.0.0.1:${address.port}/api/jobs/process` } });
      expect(JSON.parse(stdout)).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
      expect(stderr).not.toContain(secret);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
