import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_QUEUES,
  CAPABILITIES,
  ENVIRONMENT_CONTRACT,
  PRODUCTION_ENDPOINTS,
  evaluateLaunchReadiness,
  formatLaunchReadiness,
  runLaunchReadiness,
} from "./launch-readiness.mjs";

const SENTINEL = "SECRET-SENTINEL-DO-NOT-PRINT";
const CAPTURED_CONTENT = "CAPTURED-CONTENT-SENTINEL-DO-NOT-PRINT";
const CLI = "src/lib/operations/launch-readiness.mjs";

function completeEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SUPABASE_URL: "https://later-production.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: `${SENTINEL}-service-role`,
    TWILIO_AUTH_TOKEN: `${SENTINEL}-twilio-auth`,
    TWILIO_WEBHOOK_URL: "https://notfor.now/api/inbound/whatsapp",
    TWILIO_CAPTURE_USER_ID: "11111111-1111-4111-8111-111111111111",
    ANTHROPIC_API_KEY: `${SENTINEL}-anthropic`,
    ANTHROPIC_INTENT_MODEL: "claude-haiku-4-5",
    ANTHROPIC_RESOLUTION_MODEL: "claude-haiku-4-5",
    ANTHROPIC_SEGMENT_MODEL: "claude-haiku-4-5",
    SEGMENT_SOURCE_MAX_BYTES: "131072",
    JOBS_PROCESS_SECRET: `${SENTINEL}-jobs-process-secret`,
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    CAPTURE_MEDIA_MAX_BYTES: "5242880",
    RESEND_WEBHOOK_SECRET: `${SENTINEL}-resend-webhook`,
    EMAIL_INBOUND_TOKEN: "private-inbound-token",
    EMAIL_CAPTURE_USER_ID: "11111111-1111-4111-8111-111111111111",
    RESEND_API_KEY: `${SENTINEL}-resend-api`,
    RESEND_API_BASE_URL: "https://api.resend.com",
    EMAIL_MAX_BYTES: "5242880",
    NEXT_PUBLIC_SUPABASE_URL: "https://later-production.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `${SENTINEL}-public-anon`,
    RESEARCH_USER_ID: "11111111-1111-4111-8111-111111111111",
    TEST_CAPTURED_CONTENT: CAPTURED_CONTENT,
  };
}

function environmentKeys(): string[] {
  return readFileSync(".env.example", "utf8")
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

function productionSourceEnvironmentKeys(directory = "src"): string[] {
  const keys = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path !== "src/lib/operations") {
        for (const key of productionSourceEnvironmentKeys(path)) keys.add(key);
      }
      continue;
    }
    if (!/\.(?:ts|tsx|mjs)$/u.test(entry.name) || entry.name.includes(".test.")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /(?:process\.env|environment|env)\.([A-Z][A-Z0-9_]*)|requiredEnvironmentVariable\("([A-Z][A-Z0-9_]*)"\)/gu,
    )) {
      keys.add(match[1] ?? match[2]);
    }
  }
  return [...keys];
}

function actualApiEndpoints(directory = "src/app/api"): string[] {
  const endpoints: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      endpoints.push(...actualApiEndpoints(path));
      continue;
    }
    if (entry.name !== "route.ts") continue;
    const source = readFileSync(path, "utf8");
    const route = `/api/${relative("src/app/api", directory)}`;
    for (const match of source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/gu)) {
      endpoints.push(`${match[1]} ${route}`);
    }
  }
  return endpoints;
}

afterEach(() => vi.unstubAllGlobals());

describe("v0 launch readiness", () => {
  it("AC1 exits non-zero and names only affected variables and capabilities", () => {
    const environment = completeEnvironment();
    delete environment.RESEND_API_KEY;
    environment.TWILIO_WEBHOOK_URL = "http://notfor.now/api/inbound/whatsapp";
    environment.CAPTURE_MEDIA_MAX_BYTES = "999999999";

    const command = spawnSync(process.execPath, [CLI], {
      cwd: resolve("."),
      encoding: "utf8",
      env: environment,
    });

    expect(command.status).toBe(1);
    expect(command.stderr).toBe("");
    expect(command.stdout).toContain("Launch readiness: NOT READY");
    expect(command.stdout).toContain("TWILIO_WEBHOOK_URL: malformed");
    expect(command.stdout).toContain("CAPTURE_MEDIA_MAX_BYTES: malformed");
    expect(command.stdout).toContain("RESEND_API_KEY: missing");
    expect(command.stdout).toContain("[not ready] WhatsApp capture");
    expect(command.stdout).toContain("[not ready] media retrieval");
    expect(command.stdout).toContain("[not ready] inbound email");
    expect(command.stdout).not.toContain(SENTINEL);
    expect(command.stdout).not.toContain(CAPTURED_CONTENT);
  });

  it("AC2 reports every complete v0 capability ready without a network request", () => {
    const network = vi.fn(() => {
      throw new Error("external network attempted");
    });
    vi.stubGlobal("fetch", network);

    const result = evaluateLaunchReadiness(completeEnvironment());
    expect(result).toEqual({
      ok: true,
      capabilities: CAPABILITIES.map((name) => ({ name, ready: true })),
      issues: [],
    });
    expect(network).not.toHaveBeenCalled();

    const command = spawnSync(process.execPath, [CLI], {
      cwd: resolve("."),
      encoding: "utf8",
      env: completeEnvironment(),
    });
    expect(command.status).toBe(0);
    expect(command.stderr).toBe("");
    for (const capability of CAPABILITIES) {
      expect(command.stdout).toContain(`[ready] ${capability}`);
    }
    expect(command.stdout).not.toContain(SENTINEL);
  });

  it("AC3 keeps environment, endpoint, migration, queue and batch contracts current", () => {
    const readme = readFileSync("README.md", "utf8");
    const declaredKeys = environmentKeys().sort();
    const contractKeys = ENVIRONMENT_CONTRACT.map(({ name }) => name).sort();
    expect(contractKeys).toEqual(declaredKeys);
    expect(productionSourceEnvironmentKeys().sort()).toEqual(declaredKeys);

    for (const entry of ENVIRONMENT_CONTRACT) {
      expect(entry.surface).toBeTruthy();
      expect(entry.sensitivity).toBeTruthy();
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.absent).toBeTruthy();
      const documentedRow = readme
        .split("\n")
        .find((line) => line.startsWith(`| \`${entry.name}\` |`));
      expect(documentedRow).toBeDefined();
      expect(documentedRow!.split("|").slice(1, -1).every((cell) => cell.trim().length > 0)).toBe(true);
    }

    const expectedApiEndpoints = PRODUCTION_ENDPOINTS.filter((endpoint) => endpoint !== "GET /research");
    expect(actualApiEndpoints().sort()).toEqual(expectedApiEndpoints.sort());
    expect(readFileSync("src/app/research/page.tsx", "utf8")).toContain("ResearchConsole");
    for (const endpoint of PRODUCTION_ENDPOINTS) expect(readme).toContain(`\`${endpoint}\``);

    const typeSource = readFileSync("src/lib/jobs/types.ts", "utf8");
    const union = typeSource.split("export type CaptureJobType =")[1].split(";")[0];
    const actualQueues = [...union.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
    expect(actualQueues.sort()).toEqual([...BACKGROUND_QUEUES].sort());
    for (const queue of BACKGROUND_QUEUES) expect(readme).toContain(`\`${queue}\``);
    expect(readFileSync("src/app/api/jobs/process/route.ts", "utf8")).toMatch(/maxJobs:\s*2/u);
    expect(readme).toContain("at most **two jobs**");

    const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql"));
    for (const migration of migrations) expect(readme).toContain(`\`${migration}\``);
  });

  it("AC4 gives an ordered credential-safe launch, pause, rollback and recovery procedure", () => {
    const readme = readFileSync("README.md", "utf8");
    const orderedHeadings = [
      "## 1. Prepare the operator workstation",
      "## 2. Create and migrate the production Supabase project",
      "## 3. Configure and deploy Vercel for `notfor.now`",
      "## 4. Connect Twilio WhatsApp",
      "## 5. Connect Resend inbound email",
      "## 7. Enable dispatch",
      "## 8. Post-deploy smoke matrix",
      "## 9. Pause, rollback and recover",
    ];
    let previous = -1;
    for (const heading of orderedHeadings) {
      const index = readme.indexOf(heading);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    for (const requirement of [
      "Supabase Vault interface",
      "Supabase Auth user",
      "supabase db push",
      "Vercel's encrypted environment UI",
      "required DNS change",
      "Twilio",
      "Resend",
      "active := false",
      "forward-recovered",
      "Failed jobs and immutable analyses are experiment evidence",
    ]) {
      expect(readme).toContain(requirement);
    }
    expect(readme).not.toMatch(/create_secret\s*\(/iu);
    expect(readme).not.toMatch(/--password(?:=|\s)/iu);
    expect(readme).not.toMatch(/(?:curl|http)\s+[^\n]*(?:Authorization|Bearer)/iu);
  });

  it("AC5 defines a safe acknowledgement-to-recall smoke matrix with bounded diagnostics", () => {
    const readme = readFileSync("README.md", "utf8");
    const matrix = readme.split("## 8. Post-deploy smoke matrix")[1].split("## 9.")[0];
    for (const path of [
      "WhatsApp text",
      "WhatsApp media",
      "Inbound email with attachment",
      "Background intent processing",
      "Background source processing",
      "Background segment processing",
      "Private `/research` console",
    ]) {
      expect(matrix).toContain(`| ${path} |`);
    }
    for (const outcome of [
      "Immediate acknowledgement",
      "Durable capture / job / analysis check",
      "Recall-before-reveal check",
      "Bounded failure diagnostic",
      "Saved for Later ✓",
      "Accepted",
      "recalled_at",
      "revealed_at",
      "rated_at",
      "preserve any failed rows",
    ]) {
      expect(matrix).toContain(outcome);
    }

    const sql = [...matrix.matchAll(/```sql\n([\s\S]*?)```/gu)].map((match) => match[1]).join("\n");
    expect(sql).not.toMatch(/select\s+\*/iu);
    expect(sql).not.toMatch(/raw_text|raw_payload|input_snapshot|\bresult\b|decrypted_secret|headers|body|content/iu);
  });

  it("AC6 never emits sentinel credentials or captured content and never reaches the network", () => {
    const network = vi.fn(() => {
      throw new Error(`${SENTINEL} ${CAPTURED_CONTENT}`);
    });
    vi.stubGlobal("fetch", network);

    const environment = completeEnvironment();
    environment.SUPABASE_URL = "malformed";
    let output = "";
    const exitCode = runLaunchReadiness(environment, {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toBe(formatLaunchReadiness(evaluateLaunchReadiness(environment)));
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain(CAPTURED_CONTENT);
    expect(network).not.toHaveBeenCalled();

    const sources = [
      readFileSync(CLI, "utf8"),
      readFileSync("README.md", "utf8"),
      readFileSync(".env.example", "utf8"),
    ].join("\n");
    expect(sources).not.toContain(SENTINEL);
    expect(sources).not.toContain(CAPTURED_CONTENT);
    expect(readFileSync(CLI, "utf8")).not.toMatch(/\bfetch\s*\(|node:(?:http|https|net)/u);

    expect(() => execFileSync(process.execPath, [CLI], {
      cwd: resolve("."),
      encoding: "utf8",
      env: completeEnvironment(),
    })).not.toThrow();
  });
});
