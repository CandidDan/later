import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseURL = "http://127.0.0.1:3200";

export default defineConfig({
  testDir: ".",
  testMatch: "browser-proof.spec.ts",
  outputDir: `${root}/.next/browser-results`,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  use: {
    browserName: "chromium",
    baseURL,
    viewport: { width: 320, height: 800 },
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    cwd: root,
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3200",
    url: `${baseURL}/revisit`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://return-test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-test-anon",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
