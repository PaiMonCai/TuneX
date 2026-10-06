import { describe, expect, test } from "bun:test";
import { APP_ROUTE_MOUNTS, createApp } from "../../app.ts";

describe("application route mounts", () => {
  test("critical product surfaces are declared in the application contract", () => {
    const criticalPrefixes: Array<(typeof APP_ROUTE_MOUNTS)[number]> = [
      "/api/auth",
      "/api/forwards",
      "/api/workspaces",
      "/api/plans",
      "/api/federation/v1",
      "/api/admin",
      "/api/looking-glass",
    ];
    for (const prefix of criticalPrefixes) {
      expect(APP_ROUTE_MOUNTS).toContain(prefix);
    }
  });

  test("mounted application answers known public endpoints instead of falling through to 404", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/healthz");
    expect(response.status).toBe(200);
  });
});
