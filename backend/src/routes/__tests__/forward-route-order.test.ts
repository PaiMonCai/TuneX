import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

/**
 * Hono route precedence regression: a literal sub-route must remain reachable
 * even when the same router also exposes a parameterized action route.
 *
 * Product routes are exercised by dedicated route tests (preview/topology/DNS);
 * this test protects the framework assumption without parsing production source.
 */
describe("Hono route precedence", () => {
  test("literal route registered first is not swallowed by a parameter action", async () => {
    const app = new Hono();
    app.post("/:id/dns", (c) => c.json({ route: "dns" }));
    app.post("/:id/:action", (c) => c.json({ route: "action", action: c.req.param("action") }));

    const response = await app.request("http://localhost/7/dns", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: "dns" });
  });
});
