import Redis from "ioredis";
import { env } from "./env.ts";

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (e) => {
  console.error("[redis] error:", e?.message ?? e);
});

/** 应用使用的 Redis 键空间（与原版前缀风格保持一致） */
export const RedisKeys = {
  license: "license",
  userSub: (sub: string) => `user:sub:${sub}`,
  impersonation: (token: string) => `impersonation:${token}`,
  registerBlock: "register_block",
  observerBuffer: "tunnel:observer",
} as const;

export async function redisPing(): Promise<boolean> {
  try {
    const r = await redis.ping();
    return r === "PONG";
  } catch {
    return false;
  }
}
