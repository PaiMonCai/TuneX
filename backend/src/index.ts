import { app } from "./app.ts";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { redisPing } from "./redis.ts";
import { startSocketServer } from "./socket/index.ts";

async function main() {
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (e) {
    console.error("[boot] MySQL not ready:", (e as Error).message);
  }
  const redisOk = await redisPing();
  console.log(`[boot] mysql=${dbOk ? "ok" : "FAIL"} redis=${redisOk ? "ok" : "FAIL"}`);

  // HTTP API (Hono)
  const server = Bun.serve({
    port: env.port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
    idleTimeout: 60,
  });

  // Socket.IO 在独立端口（解决 Bun.serve + Hono WebSocket 不兼容）
  startSocketServer();

  console.log(`[boot] TuneX backend listening on http://0.0.0.0:${server.port}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
