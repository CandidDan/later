import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "browser-proof.spec.ts", outputDir: "../../../.next/research-browser-results",
  forbidOnly: true, workers: 1, retries: 0, timeout: 30000, reporter: "list",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:3201", viewport: { width: 320, height: 800 }, serviceWorkers: "block" },
  webServer: {
    cwd: process.cwd(),
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3201", url: "http://127.0.0.1:3201/research", timeout: 120000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "https://research-test.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
