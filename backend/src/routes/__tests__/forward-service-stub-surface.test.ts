import { describe, expect, test } from "bun:test";

/**
 * Historical source-parsing guard removed.
 *
 * Route tests now own their mocks and the TypeScript/module loader is the source
 * of truth for named exports. This smoke test intentionally checks only that the
 * production service surface can be imported; it does not freeze its exact list
 * of exports or test-file implementation.
 */
describe("forward service module surface", () => {
  test("production module loads with the route-facing operations", async () => {
    const service = await import("../../services/forward-service.ts");
    for (const name of [
      "createForward",
      "deleteForward",
      "getForward",
      "listForwardsPage",
      "patchForward",
      "previewForwardUpdate",
      "runForwardAction",
      "runForwardBatch",
    ]) {
      expect(typeof service[name as keyof typeof service]).toBe("function");
    }
  });
});
