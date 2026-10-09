import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

// Preload in each fresh test process. Tests must inject their own DB; a missed
// seam fails locally instead of ever dialing MySQL or Redis.
const forbiddenDb = new Proxy({}, { get(_target, model: string) {
  if (model === "then") return undefined;
  return new Proxy(() => { throw new Error(`offline DB forbidden: ${model}`); }, {
    get(_table, operation: string) { return () => { throw new Error(`offline DB forbidden: ${model}.${operation}`); }; },
  });
} });
mock.module(fileURLToPath(new URL("../src/db.ts", import.meta.url)), () => ({ db: forbiddenDb }));
mock.module("ioredis", () => ({ default: class OfflineRedis {
  on() { return this; }
  get() { return Promise.resolve(null); }
  set() { return Promise.resolve(null); }
  del() { return Promise.resolve(0); }
  eval() { return Promise.resolve(null); }
  scan() { return Promise.resolve(["0", []]); }
  disconnect() {}
} }));
