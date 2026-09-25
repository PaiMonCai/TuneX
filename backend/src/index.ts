import { app } from "./app.ts";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { redisPing } from "./redis.ts";

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

  // WP15：Socket.IO agent 接入层（register / license 签名 / Fernet config 下发）
  // 随 legacy 引擎一起删除。v3 节点通过 `POST /api/internal/node/state` 上报、
  // 由 orchestrator 经 agent admin API（HTTP）下发 revisioned apply 命令，
  // 不再需要独立的 socket 端口（§7.16 执行要求 1/4）。

  console.log(`[boot] TuneX backend listening on http://0.0.0.0:${server.port}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
