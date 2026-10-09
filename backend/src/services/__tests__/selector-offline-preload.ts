import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

// Scoped selector regression runs must never instantiate database or Redis clients.
process.env.AUTH_SECRET ||= "offline-selector-regression-only";
process.env.DATABASE_URL ||= "mysql://unused:unused@127.0.0.1:1/unused";
const deniedRead = (name: string) => async () => {
  throw new Error(`offline regression requires an injected store: ${name}`);
};
const models = new Proxy<Record<string, unknown>>({}, {
  get(_target, model: string) {
    if (model === "then") return undefined;
    if (model === "nodeStateReport") return { findUnique: async () => null };
    if (model === "targetObservation") return { findMany: deniedRead("targetObservation.findMany") };
    return new Proxy({}, { get: (_unused, operation: string) => deniedRead(`${model}.${operation}`) });
  },
});
mock.module(fileURLToPath(new URL("../../db.ts", import.meta.url)), () => ({ db: models }));
mock.module("ioredis", () => ({
  default: class OfflineRedis {
    on() { return this; }
    constructor() {
      return new Proxy(this, {
        get: (target, key: string) => key === "on" ? target.on.bind(target) : deniedRead(`redis.${key}`),
      });
    }
  },
}));
