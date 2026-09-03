import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

it(
  "AC5 production client output excludes the service-role value and privileged client",
  () => {
    const serviceRoleSentinel = "service-role-must-never-reach-client-output";
    const clientOutput = filesUnder(join(process.cwd(), ".next", "static"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const privilegedSource = readFileSync(
      join(process.cwd(), "src/lib/supabase/server.ts"),
      "utf8",
    );
    const persistenceSource = readFileSync(
      join(process.cwd(), "src/lib/capture/persist.ts"),
      "utf8",
    );

    expect(privilegedSource).toMatch(/^import "server-only";/u);
    expect(persistenceSource).toMatch(/^import "server-only";/u);
    expect(clientOutput).not.toContain(serviceRoleSentinel);
    expect(clientOutput).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(clientOutput).not.toContain("createServiceRoleClient");
  },
);
