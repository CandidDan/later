import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

// Pinned Supabase PostgreSQL supplies pgcrypto and pgTAP on both arm64 and amd64.
// No app database, host port, mounted host directory, or external network is used.
// Exact multi-architecture manifest of 15.8.1.085; identical in both registries.
const digest = "sha256:af083ef64d0408c8f098ee6f5c364a59b26f36fbc0f3a334a62c5c1d57362e9b";
const images = ["docker.io/supabase/postgres", "public.ecr.aws/supabase/postgres"].map(repo => `${repo}@${digest}`);
type DockerCommand = (command: string[], timeout?: number) => string;
export async function acquireDatabaseImage(
  docker: DockerCommand,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
) {
  for (const image of images) {
    try { docker(["image", "inspect", image], 5000); return image; }
    catch { /* A fresh runner needs a pull. */ }
  }
  const deadline = Date.now() + 300000;
  let lastError: unknown;
  // Shared runners can exhaust either registry's anonymous quota. Try the same
  // immutable image through the other registry, then retry once within a total budget.
  // Cold hosted runners can take over a minute to extract this image after downloading
  // it. Keep acquisition bounded without killing a healthy pull during extraction.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const image of images) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Pinned database image pull exceeded 300 seconds", { cause: lastError });
      try { docker(["pull", image], Math.min(180000, remaining)); return image; }
      catch (error) { lastError = error; }
    }
    if (attempt === 0) await wait(1000);
  }
  throw new Error("Neither registry could supply the required pinned database image", { cause: lastError });
}
export function disposableDatabase() {
  const container = `later-revisit-test-${randomUUID()}`;
  const args = ["exec", "-i", container, "psql", "-h", "/tmp", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  function docker(command: string[], timeout = 30000) {
    return execFileSync("docker", command, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] });
  }
  function sql(input: string) {
    return execFileSync("docker", args, { input, encoding: "utf8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  }
  let started = false;
  function stop() {
    if (started) {
      docker(["rm", "--force", "--volumes", container]);
      started = false;
    }
  }
  async function start() {
    try {
      docker(["info", "--format", "{{.ServerVersion}}"], 5000);
      const image = await acquireDatabaseImage(docker);
      started = true; // Even a timed-out run can have created the named container.
      docker(["run", "--detach", "--name", container, "--network", "none", "--user", "postgres",
        "--tmpfs", "/tmp:rw,nosuid,size=256m", "--entrypoint", "sh", image, "-c",
        "initdb -D /tmp/revisit-db --auth=trust --no-locale > /tmp/initdb.log && exec postgres -D /tmp/revisit-db -c listen_addresses='' -c unix_socket_directories=/tmp"]);
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          docker(["exec", container, "pg_isready", "-h", "/tmp", "-U", "postgres"], 2000);
          ready = true;
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (!ready) throw new Error("Disposable PostgreSQL did not become ready within 30 seconds");
      sql(readFileSync(new URL("./database-bootstrap.sql", import.meta.url), "utf8"));
      for (const migration of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
        // Unrelated scheduler requires pg_cron/net and its primary app database.
        if (migration === "20260907030000_schedule_intent_processing.sql") continue;
        sql(readFileSync(`supabase/migrations/${migration}`, "utf8"));
      }
    } catch (error) {
      stop();
      throw new Error("Required revisit database proof could not start. Install/start Docker and allow the pinned test image pull.", { cause: error });
    }
  }
  return { start, stop, sql, args };
}
