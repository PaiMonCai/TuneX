import { Server as HTTPServer, createServer } from "node:http";
import { Server as IOServer, type Socket } from "socket.io";
import { db } from "../db.ts";
import { redis } from "../redis.ts";
import { env } from "../env.ts";
import { systemConfig } from "../services/config.ts";
import { signLicenseForAgent } from "../services/license-sign.ts";
import { OUT_LISTEN_KEY } from "./config-generator.ts";
import { pushNodeConfig } from "./config-pusher.ts";
import {
  ERR_PORT_IN_USE,
  handleListenError,
  parseListenName,
  type ListenEventPayload,
} from "./listen-events.ts";
import {
  DISCONNECT_MARKER_TTL_S,
  disconnectMarkerKey,
} from "./offline-detector.ts";

const SOCKET_PORT = Number(process.env.SOCKET_PORT ?? 3001);

/**
 * Socket.IO agent 接入层
 *
 * 协议事实（全部实测验证，见 config-e2e.md）：
 *  - Engine.IO v4，agent CONNECT 载荷 {"token": "<node_group.token>"}
 *  - register ACK 格式必须是 43<id>[json]（43=ACK；44 是 ERROR 包）
 *  - ACK 载荷 {license, site_url, type, now}；license 内层是 int64 unix 秒
 *  - config 下发 42["config","<fernet>"]——裸字符串，不是数组
 *  - sysinfo 每 10s 一次，Redis 缓存 + room 管理
 */

interface RegisterPayload {
  node_id: string;
  connect_ip: string[];
  ports?: Record<string, number>;
  sysinfo?: Record<string, unknown>;
  version?: string;
}

interface ListenPayload {
  /** agent 自报节点标识（node.node_id 字符串，非数字主键） */
  node_id: string;
  port: number;
  type: string;
  name: string;
}

const SYSINFO_TTL_S = 30;

/** Prisma 唯一约束冲突（监听端口同组占用）。 */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

/**
 * `listen` 回填：仅当隧道 `listen_port` 仍为空时写入实际端口。
 * 唯一约束（`@@unique([listen_port, in_node_group_id])`）冲突 → 记录
 * `port_conflict_at` 并重推该隧道所在组（复刻上游 `repushTunnelGroup` 语义）。
 */
async function backfillTunnelListenPort(tunnelId: number, port: number): Promise<void> {
  try {
    await db.tunnel.updateMany({
      where: { id: tunnelId, listen_port: null },
      data: { listen_port: port },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    console.warn(
      `[listen] tunnel ${tunnelId} port ${port} conflicts with another tunnel in the same group, repushing config`,
    );
    await db.tunnel.updateMany({ where: { id: tunnelId }, data: { port_conflict_at: new Date() } });
    const t = await db.tunnel.findUnique({
      where: { id: tunnelId },
      select: { in_node_group_id: true },
    });
    if (t?.in_node_group_id) {
      void pushNodeConfig(t.in_node_group_id, { force: true }).catch(() => {});
    }
  }
}

export function attachSocketIO(httpServer: HTTPServer): IOServer {
  const io = new IOServer(httpServer, {
    path: "/socket.io",
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ["polling", "websocket"],
    cors: { origin: true, credentials: true },
  });

  // 连接中间件：CONNECT 载荷里的 token → nodeGroup
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? "";
      if (!token) return next(new Error("unauthorized"));
      const group = await db.nodeGroup.findUnique({ where: { token } });
      if (!group) return next(new Error("unauthorized"));
      socket.data.group = group;
      socket.data.groupId = group.id;
      next();
    } catch (e) {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const groupId = socket.data.groupId as number;
    const room = `node_group/${groupId}`;
    socket.join(room);

    // ---- register（带 ack）----
    socket.on("register", async (data: RegisterPayload, ack?: (v: unknown) => void) => {
      try {
        const group = socket.data.group;
        const now = Math.floor(Date.now() / 1000);

        // 1. 防暴力重试（registerBlock）
        const blockKey = `register_block:${group.token}`;
        const blocked = await redis.get(blockKey);
        if (blocked) {
          ack?.({ error: blocked });
          return;
        }

        // 2. license（自签，永不过期）
        const licenseToken = signLicenseForAgent({
          expiredAt: 4102444799, // 2100-01-01，int64 unix 秒
          type: "business",
          siteUrl: env.siteUrl, // 必须与 agent -s 参数一致
        });

        // 3. upsert node（connect_ip 变化时更新）
        const connectIp = (data.connect_ip ?? []).join(",");
        const existing = await db.node.findUnique({ where: { node_id: data.node_id } });
        if (!existing) {
          const order = await db.node.count({ where: { node_group_id: group.id } });
          await db.node.create({
            data: {
              node_id: data.node_id,
              connect_ip: connectIp,
              node_group_id: group.id,
              version: data.version ?? "",
              order_by: order * 1000,
            },
          });
        } else if (existing.connect_ip !== connectIp || existing.version !== data.version) {
          await db.node.update({
            where: { node_id: data.node_id },
            data: { connect_ip: connectIp, version: data.version ?? "" },
          });
        }

        // 绑定到 socket，供 disconnect 反查节点（见下方 disconnect 处理）
        socket.data.nodeId = data.node_id;

        // 节点（重）上线：取消待处理离线标记，并把可能被 worker 置为 inactive 的
        // 节点拉回 active（节点活着就等于在线，避免刚上线仍显示离线）。
        await redis.del(disconnectMarkerKey(group.id, data.node_id));
        await db.node
          .updateMany({
            where: { node_id: data.node_id, status: "inactive" },
            data: { status: "active" },
          })
          .catch(() => {});

        // 4. ACK 430 四件套（license/site_url/type/now）
        ack?.({
          license: licenseToken,
          site_url: env.siteUrl,
          type: "business",
          now,
        });

        // 5. 立即推一次配置（节点上线，强制下发，跳过去重）
        void pushNodeConfig(groupId, { force: true }).catch(() => {});
      } catch (e) {
        ack?.({ error: "internal error" });
      }
    });

    // ---- sysinfo（无 ack，10s 心跳）----
    socket.on("sysinfo", async (data: { node_id: string; sysinfo?: Record<string, unknown> }) => {
      try {
        const key = `sysinfo:${groupId}:${data.node_id}`;
        await redis.set(key, JSON.stringify({ ...data, last_active: new Date().toISOString() }), "EX", SYSINFO_TTL_S);
        // room 动态管理：有心跳的节点组保持活跃集合（pushNodeConfig 用于过滤）
        await redis.sadd(`alive_groups`, String(groupId));
        // 心跳即「节点仍在线」：取消可能存在的待处理离线标记（重连防抖）。
        await redis.del(disconnectMarkerKey(groupId, data.node_id));
      } catch {
        /* 心跳失败不影响连接 */
      }
    });

    // ---- listen（agent 监听端口回传）----
    // payload: { node_id, name, port, type }
    //   name 形如 "tcp-<tunnelId>" / "udp-<tunnelId>" / 出口服务名
    // 写入口径必须与 loadOutListens() 读取口径严格一致：
    //   key = tunnel:out_listen（与 OUT_LISTEN_KEY 常量同源，勿再拼错前缀）
    //   field = <node.id>:<type>   ← node.id 是数字主键，不是 node_id 字符串
    //   value = <port>             ← 只存端口，type 已在 field 里
    socket.on("listen", async (data: ListenPayload, ack?: (v: unknown) => void) => {
      try {
        const { tunnelId } = parseListenName(data.name);
        if (tunnelId !== null) {
          // 隧道监听端口回写（仅 listen_port 为空时；冲突则记 port_conflict_at + 重推）
          await backfillTunnelListenPort(tunnelId, data.port);
        } else {
          // 出口监听：node_id 字符串 → 数字主键（供 out_hops 拼 addr）
          const node = await db.node.findUnique({
            where: { node_id: data.node_id },
            select: { id: true },
          });
          if (node) {
            await redis.hset(OUT_LISTEN_KEY, `${node.id}:${data.type}`, String(data.port));
          }
        }
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });

    // ---- listen_error（agent 端口绑定失败，运行时冲突闭环）----
    // 修复缺陷#3：此前无 handler，事件被静默丢弃。ERR_PORT_IN_USE → 隧道置
    // inactive + 写 port_conflict_at（复刻上游 listen_error.ts 语义）。
    socket.on("listen_error", async (data: ListenEventPayload) => {
      await handleListenError(data).catch(() => {});
    });

    // ---- disconnect（60s 防抖）----
    // 标记按 node_id 而非 socket.id：worker/查询侧需要按节点反查离线状态，
    // socket.id 每次重连都变，用它做 key 等于无法反查。
    // 标记由 offline-detector.ts 的 worker 消费：防抖到点且无心跳 → 置 inactive；
    // 期间节点重连（register/sysinfo）会删除该标记，取消待处理离线。
    socket.on("disconnect", async (reason) => {
      const nodeId = socket.data.nodeId as string | undefined;
      if (!nodeId) return; // 未 register 过的连接，无节点可标记
      // TTL = 防抖窗口 + 宽限期（见 offline-detector.ts）：保证防抖到点后 worker
      // 至少能扫到一次，避免「标记在两次扫描之间过期」导致漏判。
      await redis.set(
        disconnectMarkerKey(groupId, nodeId),
        String(Date.now()),
        "EX",
        DISCONNECT_MARKER_TTL_S,
      );
    });
  });

  (globalThis as Record<string, unknown>).__io = io;
  return io;
}

export function startSocketServer(): void {
  const httpServer = createServer();
  const io = attachSocketIO(httpServer);
  httpServer.listen(SOCKET_PORT, "0.0.0.0", () => {
    console.log(`[boot] Socket.IO agent server listening on :${SOCKET_PORT}`);
  });
  (globalThis as Record<string, unknown>).__io = io;
}
