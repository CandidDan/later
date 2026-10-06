import { describe, expect, it, vi } from "vitest";
import { acquireDatabaseImage } from "./database-fixture";

// These test image acquisition only. database.test.ts still executes real SQL,
// pgTAP and concurrent transactions; no database outcome is mocked here.
describe("required database image acquisition", () => {
  it("reuses the exact cached image without a registry request", async () => {
    const docker = vi.fn(() => "cached");
    const image = await acquireDatabaseImage(docker);
    expect(docker.mock.calls).toHaveLength(1);
    expect(image).toMatch(/^docker.io\/supabase\/postgres@sha256:/);
  });
  it("registry throttling falls back to the identical immutable image", async () => {
    const commands: string[][] = [];
    const docker = (command: string[]) => {
      commands.push(command);
      if (command[0] === "image" || command[1].startsWith("docker.io/")) throw new Error("toomanyrequests");
      return "pulled";
    };
    const image = await acquireDatabaseImage(docker);
    const pulls = commands.filter(command => command[0] === "pull");
    expect(pulls).toHaveLength(2);
    expect(pulls[0][1].split("@")[1]).toBe(pulls[1][1].split("@")[1]);
    expect(image).toBe(pulls[1][1]);
  });
  it("transient registry failure retries once before starting the required proof", async () => {
    let pulls = 0;
    const wait = vi.fn(async () => {});
    const image = await acquireDatabaseImage(command => {
      if (command[0] === "image") throw new Error("missing");
      if (++pulls < 3) throw new Error("toomanyrequests");
      return "pulled";
    }, wait);
    expect(pulls).toBe(3);
    expect(wait).toHaveBeenCalledWith(1000);
    expect(image).toMatch(/^docker.io\//);
  });
  it("both registries unavailable fails after bounded attempts instead of skipping", async () => {
    const commands: string[][] = [];
    await expect(acquireDatabaseImage(command => {
      commands.push(command);
      throw new Error("toomanyrequests");
    }, async () => {})).rejects.toThrow("Neither registry could supply");
    expect(commands.filter(command => command[0] === "pull")).toHaveLength(4);
  });
});
