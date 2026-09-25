/**
 * 隧道路由（用户侧）—— 前端 api.tunnels.*
 *
 * 端点（挂载于 /api/tunnels）：
 *   GET    /            隧道列表（仅本人；分页/关键字/状态过滤）
 *   POST   /            创建隧道
 *   GET    /:id         隧道详情
 *   PATCH  /:id         更新隧道
 *   DELETE /:id         删除隧道
 *   POST   /:id/toggle  启用/停用切换
 *   GET    /:id/traffic 隧道流量序列（近 N 天）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { tunnelsRoutes } from "./routes/tunnels.ts";
 *   app.route("/api/tunnels", tunnelsRoutes);
 *
 * 响应封装：前端 lib/api.ts 的 request() 会剥掉 **一层** 顶层 `data`，
 * 故这里统一 `c.json({ data: <payload> })`：
 *   · 单对象 → payload 为对象
 *   · 列表   → payload 为分页对象 { data: rows, total, page, page_size }
 * 前端拿到 payload 后即可直接使用（列表即 Paginated<T>）。
 *
 * 认证：/api/tunnels/* 不在免认证白名单内，app.ts 全局 authRequired 已注入用户。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { canUseNodeGroup } from "../services/node-group-access.ts";
import { canWorkspaceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import {
  countWorkspaceTunnels,
  sumWorkspaceTraffic,
  withWorkspaceQuotaLock,
} from "../services/policy-service.ts";
import { checkTunnelCreation } from "../services/capability-policy.ts";
import { getOrchestrator } from "../services/relay-wiring.ts";
import {
  listTunnels as listTunnelsApi,
  createTunnel as createTunnelApi,
  getTunnelState as getTunnelStateApi,
  updateTunnel as updateTunnelApi,
  runTunnelAction as runTunnelActionApi,
  parseApplyStatusFilter,
  parseTunnelMode,
  TUNNEL_API_ERROR_STATUS,
  type TunnelModeValue,
} from "../services/tunnel-api.ts";

export const tunnelsRoutes = new Hono<{ Variables: AppVariables }>();

// Every user route selects a verified workspace; missing header means personal space.
tunnelsRoutes.use("*", async (c, next) => {
  const isCreate = c.req.method === "POST" && /^\/api\/tunnels\/?$/.test(c.req.path);
  c.set("workspace", await resolveWorkspaceAccess(c, isCreate ? "create" : "read"));
  await next();
});

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

type Ctx = Context<{ Variables: AppVariables }>;

function selectedWorkspace(c: Ctx): NonNullable<AppVariables["workspace"]> {
  const workspace = c.get("workspace");
  if (!workspace) throw new HTTPException(403, { message: "工作空间未授权" });
  return workspace;
}

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** 统一成功响应：外层包一层 data（前端 request() 会剥掉） */
function ok<T>(c: Ctx, payload: T) {
  return c.json({ data: payload });
}

interface PageQuery {
  page: number;
  page_size: number;
  skip: number;
  take: number;
  keyword: string;
  status?: string;
}

function readPage(c: Ctx): PageQuery {
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  return {
    page,
    page_size,
    skip: (page - 1) * page_size,
    take: page_size,
    keyword: String(q.keyword ?? "").trim(),
    status: q.status && q.status !== "all" ? String(q.status) : undefined,
  };
}

/** 两段式检索：统计总数 + 取当前页 */
async function paginateQuery<T>(
  c: Ctx,
  findMany: () => Promise<T[]>,
  count: () => Promise<number>,
) {
  const { page, page_size } = readPage(c);
  const [rows, total] = await Promise.all([findMany(), count()]);
  return ok(c, { data: rows, total, page, page_size });
}

const FORWARD_RE = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):\d{1,5}$/;

/** 转发目标：接受字符串数组或逗号/换行分隔字符串，空 → [] */
function parseForward(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** 对外隧道视图：补 online（schema 无运行态列，按 status 近似） */
function tunnelView(t: Record<string, unknown>) {
  return { ...t, online: t.status === "active" };
}

/* ------------------------------------------------------------------ */
/* GET / —— 列表                                                       */
/* ------------------------------------------------------------------ */

tunnelsRoutes.get("/", async (c) => {
  const user = requireUser(c);
  const { keyword, status, skip, take } = readPage(c);

  const workspace = selectedWorkspace(c);
  const where = {
    workspace_id: workspace.id,
    ...(status ? { status: status as "active" | "inactive" } : {}),
    ...(keyword ? { name: { contains: keyword } } : {}),
  };

  return paginateQuery(
    c,
    () =>
      db.tunnel.findMany({
        where,
        orderBy: [{ order_by: "asc" }, { id: "desc" }],
        skip,
        take,
        include: {
          in_node_group: { select: { id: true, name: true, node_type: true } },
          out_node_group: { select: { id: true, name: true, node_type: true } },
        },
      }),
    () => db.tunnel.count({ where }),
  );
});

/* ------------------------------------------------------------------ */
/* POST / —— 创建                                                      */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  // Route-level check, independent of Hono mount-path normalization.
  if (!canWorkspaceAction(workspace.role, "create")) return c.json({ error: "无权创建团队隧道" }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "隧道名称不能为空" }, 400);
  if (name.length > 60) return c.json({ error: "隧道名称长度不能超过 60 字符" }, 400);

  const inGroupId = Number(body.in_node_group_id);
  if (!Number.isInteger(inGroupId)) return c.json({ error: "必须指定入口节点组" }, 400);
  const inGroup = await db.nodeGroup.findUnique({ where: { id: inGroupId } });
  if (!inGroup) return c.json({ error: "入口节点组不存在" }, 404);
  if (inGroup.node_type !== "in" || !(await canUseNodeGroup(user.id, inGroup, "in", workspace.id, workspace.personalWorkspaceId)))
    return c.json({ error: "无权使用入口节点组" }, 403);

  let outGroupId: number | null = null;
  let outGroupOwnedByWorkspace = true;
  if (body.out_node_group_id !== undefined && body.out_node_group_id !== null && body.out_node_group_id !== "") {
    const parsed = Number(body.out_node_group_id);
    if (!Number.isInteger(parsed)) return c.json({ error: "出口节点组非法" }, 400);
    const outGroup = await db.nodeGroup.findUnique({ where: { id: parsed } });
    if (!outGroup) return c.json({ error: "出口节点组不存在" }, 404);
    if (outGroup.node_type !== "out" || !(await canUseNodeGroup(user.id, outGroup, "out", workspace.id, workspace.personalWorkspaceId)))
      return c.json({ error: "无权使用出口节点组" }, 403);
    outGroupId = outGroup.id;
    outGroupOwnedByWorkspace = outGroup.workspace_id === workspace.id;
  }

  const forward = parseForward(body.forward_addresses);
  if (forward.length === 0) return c.json({ error: "至少需要一个转发目标" }, 400);
  const bad = forward.find((a) => !FORWARD_RE.test(a));
  if (bad) return c.json({ error: `转发目标格式应为 host:port（${bad}）` }, 400);

  let listenPort: number | null = null;
  if (body.listen_port !== undefined && body.listen_port !== null && body.listen_port !== "") {
    const port = Number(body.listen_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: "监听端口必须在 1-65535 之间" }, 400);
    }
    const conflict = await db.tunnel.findFirst({
      where: { in_node_group_id: inGroupId, listen_port: port },
    });
    if (conflict) return c.json({ error: "监听端口已被占用" }, 400);
    listenPort = port;
  }

  const tunnelType = String(body.tunnel_type ?? "tcp");
  const category = body.category === "remote_port_forward" ? "remote_port_forward" : "port_forward";

  // order_by 在锁内重算（与额度判定同事务，保证顺序稳定）
  const inGroupOwned = inGroup.workspace_id === workspace.id;
  const outGroupOwned = outGroupId === null || outGroupId === inGroupId ? true : outGroupOwnedByWorkspace;

  // SOFT-01：额度判定与落库在同一 workspace 行锁事务内完成（FOR UPDATE 串行化
  // 同 workspace 的并发创建），杜绝「先查计数再插入」的 TOCTOU 超发。
  const result = await withWorkspaceQuotaLock(workspace.id, async (tx, policy) => {
    const [tunnelCount, trafficUsed, maxOrder] = await Promise.all([
      countWorkspaceTunnels(workspace.id, tx),
      sumWorkspaceTraffic(workspace.id, policy.limits.traffic_period, new Date(), tx),
      tx.tunnel.aggregate({ _max: { order_by: true } }),
    ]);
    const nextOrder = (maxOrder._max.order_by ?? 0) + 10;
    const decision = checkTunnelCreation(policy, {
      tunnelCount,
      trafficUsed,
      protocol: tunnelType,
      inGroupOwned,
      inGroupId: inGroup.id,
      outGroupId: outGroupId,
      outGroupOwned,
    });
    if (!decision.allowed) return { denied: decision } as const;

    const created = await tx.tunnel.create({
      data: {
        name,
        tunnel_type: tunnelType as never,
        category: category as never,
        listen_ip: body.listen_ip ? String(body.listen_ip) : "0.0.0.0",
        listen_port: listenPort,
        listen_protocol: [tunnelType],
        status: "active",
        forward_addresses: forward,
        forward_addresses_protocol: forward.map(() => tunnelType),
        load_balance_type: String(body.load_balance_type ?? "round") as never,
        ip_type: String(body.ip_type ?? "ipv4") as never,
        order_by: nextOrder,
        ip_limit: body.ip_limit === undefined || body.ip_limit === null || body.ip_limit === "" ? null : Number(body.ip_limit),
        client_limit: body.client_limit === undefined || body.client_limit === null || body.client_limit === "" ? null : Number(body.client_limit),
        bandwidth_limit: body.bandwidth_limit === undefined || body.bandwidth_limit === null || body.bandwidth_limit === "" ? null : Number(body.bandwidth_limit),
        proxy_protocol: Boolean(body.proxy_protocol),
        in_node_group_id: inGroup.id,
        out_node_group_id: outGroupId,
        user_id: user.id,
        workspace_id: workspace.id,
      },
      include: {
        in_node_group: { select: { id: true, name: true, node_type: true } },
        out_node_group: { select: { id: true, name: true, node_type: true } },
      },
    });
    return { tunnel: created } as const;
  });

  const created = "tunnel" in result ? result.tunnel : null;
  if (!created) {
    const decision = "denied" in result ? result.denied : null;
    return c.json({ error: decision?.message ?? "策略拒绝", code: decision?.reason }, 403);
  }

  // WP15：旧 Agent 的配置推送旁路已删（config-generator/config-pusher 随 legacy
  // 引擎移除）。传播由 orchestrator + reconciler 负责：隧道落库后 reconciler
  // 拉齐 apply 命令，节点心跳带 revision，无需「写操作 → 立即推配置」。
  return ok(c, tunnelView(created as unknown as Record<string, unknown>));
});

/* ------------------------------------------------------------------ */
/* GET /:id/traffic —— 流量序列                                        */
/* ------------------------------------------------------------------ */

tunnelsRoutes.get("/:id/traffic", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({ where: { id, workspace_id: selectedWorkspace(c).id } });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);

  const days = Math.max(1, Math.min(90, Number(c.req.query("days") ?? 14) || 14));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const rows = await db.tunnelTraffic.findMany({
    where: { tunnel_id: tunnel.id, date: { gte: since } },
    orderBy: { date: "asc" },
  });

  // 按 YYYY-MM-DD 聚合（同一天可能多条）
  const byDate = new Map<string, { traffic: number; traffic_cost: number }>();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const acc = byDate.get(key) ?? { traffic: 0, traffic_cost: 0 };
    acc.traffic += r.traffic;
    acc.traffic_cost += r.traffic_cost;
    byDate.set(key, acc);
  }

  // 补齐缺失日期为 0，保证前端图表点数稳定
  const points: { date: string; traffic: number; traffic_cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const hit = byDate.get(key);
    points.push({
      date: key,
      traffic: hit ? Number(hit.traffic.toFixed(2)) : 0,
      traffic_cost: hit ? Number(hit.traffic_cost.toFixed(4)) : 0,
    });
  }

  return ok(c, points);
});

/* ------------------------------------------------------------------ */
/* GET /:id —— 详情                                                    */
/* ------------------------------------------------------------------ */

tunnelsRoutes.get("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({
    where: { id, workspace_id: selectedWorkspace(c).id },
    include: {
      in_node_group: { select: { id: true, name: true, node_type: true } },
      out_node_group: { select: { id: true, name: true, node_type: true } },
      user: { select: { id: true, email: true } },
    },
  });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);
  return ok(c, tunnelView(tunnel as unknown as Record<string, unknown>));
});

/* ------------------------------------------------------------------ */
/* PATCH /:id —— 更新                                                  */
/* ------------------------------------------------------------------ */

tunnelsRoutes.patch("/:id", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({ where: { id, workspace_id: selectedWorkspace(c).id } });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(selectedWorkspace(c).role, "update", tunnel.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return c.json({ error: "隧道名称不能为空" }, 400);
    if (name.length > 60) return c.json({ error: "隧道名称长度不能超过 60 字符" }, 400);
    data.name = name;
  }

  if (body.in_node_group_id !== undefined) {
    const gid = Number(body.in_node_group_id);
    const g = Number.isInteger(gid) ? await db.nodeGroup.findUnique({ where: { id: gid } }) : null;
    if (!g) return c.json({ error: "入口节点组不存在" }, 404);
    if (g.node_type !== "in" || !(await canUseNodeGroup(user.id, g, "in", workspace.id, workspace.personalWorkspaceId)))
      return c.json({ error: "无权使用入口节点组" }, 403);
    data.in_node_group_id = g.id;
  }
  if (body.out_node_group_id !== undefined) {
    if (body.out_node_group_id === null || body.out_node_group_id === "") {
      data.out_node_group_id = null;
    } else {
      const oid = Number(body.out_node_group_id);
      const g = Number.isInteger(oid) ? await db.nodeGroup.findUnique({ where: { id: oid } }) : null;
      if (!g) return c.json({ error: "出口节点组不存在" }, 404);
      if (g.node_type !== "out" || !(await canUseNodeGroup(user.id, g, "out", workspace.id, workspace.personalWorkspaceId)))
        return c.json({ error: "无权使用出口节点组" }, 403);
      data.out_node_group_id = g.id;
    }
  }

  if (body.listen_port !== undefined) {
    if (body.listen_port === null || body.listen_port === "") {
      data.listen_port = null;
    } else {
      const port = Number(body.listen_port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return c.json({ error: "监听端口必须在 1-65535 之间" }, 400);
      }
      const inGroupId = (data.in_node_group_id as number | undefined) ?? tunnel.in_node_group_id;
      const conflict = await db.tunnel.findFirst({
        where: { in_node_group_id: inGroupId, listen_port: port, NOT: { id: tunnel.id } },
      });
      if (conflict) return c.json({ error: "监听端口已被占用" }, 400);
      data.listen_port = port;
    }
  }

  if (body.forward_addresses !== undefined) {
    const forward = parseForward(body.forward_addresses);
    if (forward.length === 0) return c.json({ error: "至少需要一个转发目标" }, 400);
    const bad = forward.find((a) => !FORWARD_RE.test(a));
    if (bad) return c.json({ error: `转发目标格式应为 host:port（${bad}）` }, 400);
    data.forward_addresses = forward;
    const ttype = (body.tunnel_type as string | undefined) ?? tunnel.tunnel_type;
    data.forward_addresses_protocol = forward.map(() => ttype);
  }

  if (body.tunnel_type !== undefined) {
    const ttype = String(body.tunnel_type);
    data.tunnel_type = ttype;
    data.listen_protocol = [ttype];
    const addrs = (data.forward_addresses as string[] | undefined) ?? (tunnel.forward_addresses as string[]);
    data.forward_addresses_protocol = addrs.map(() => ttype);
  }

  if (body.load_balance_type !== undefined) data.load_balance_type = String(body.load_balance_type);
  if (body.ip_type !== undefined) data.ip_type = String(body.ip_type);
  if (body.category !== undefined) {
    data.category = body.category === "remote_port_forward" ? "remote_port_forward" : "port_forward";
  }
  if (body.status !== undefined) {
    const s = String(body.status);
    if (s !== "active" && s !== "inactive") return c.json({ error: "状态不合法" }, 400);
    data.status = s;
  }
  if (body.order_by !== undefined) {
    const ob = Number(body.order_by);
    if (Number.isFinite(ob)) data.order_by = ob;
  }
  for (const key of ["ip_limit", "client_limit", "bandwidth_limit"] as const) {
    if (body[key] !== undefined) {
      if (body[key] === null || body[key] === "") data[key] = null;
      else {
        const n = Number(body[key]);
        if (!Number.isFinite(n)) return c.json({ error: `${key} 必须是数字` }, 400);
        data[key] = n;
      }
    }
  }
  if (body.proxy_protocol !== undefined) data.proxy_protocol = Boolean(body.proxy_protocol);

  const updated = await db.tunnel.update({
    where: { id: tunnel.id },
    data,
    include: {
      in_node_group: { select: { id: true, name: true, node_type: true } },
      out_node_group: { select: { id: true, name: true, node_type: true } },
    },
  });

  // WP15：换节点组/改配置不再触发 legacy 推送；v3 由 reconciler 拉齐 apply 命令。
  return ok(c, tunnelView(updated as unknown as Record<string, unknown>));
});

/* ------------------------------------------------------------------ */
/* POST /:id/toggle —— 启用/停用切换                                    */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/:id/toggle", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({ where: { id, workspace_id: selectedWorkspace(c).id } });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(selectedWorkspace(c).role, "update", tunnel.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const next = tunnel.status === "active" ? "inactive" : "active";
  const updated = await db.tunnel.update({
    where: { id: tunnel.id },
    data: { status: next },
    include: {
      in_node_group: { select: { id: true, name: true, node_type: true } },
      out_node_group: { select: { id: true, name: true, node_type: true } },
    },
  });

  // WP15：状态变化不再触发 legacy 推送；v3 由 reconciler 拉齐。
  return ok(c, tunnelView(updated as unknown as Record<string, unknown>));
});

/* ------------------------------------------------------------------ */
/* POST /:id/reset-traffic —— 重置流量计数                              */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/:id/reset-traffic", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({ where: { id, workspace_id: selectedWorkspace(c).id } });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(selectedWorkspace(c).role, "update", tunnel.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const updated = await db.tunnel.update({
    where: { id: tunnel.id },
    data: { traffic: 0, traffic_cost: 0 },
    include: {
      in_node_group: { select: { id: true, name: true, node_type: true } },
      out_node_group: { select: { id: true, name: true, node_type: true } },
    },
  });
  return ok(c, tunnelView(updated as unknown as Record<string, unknown>));
});

/* ------------------------------------------------------------------ */
/* DELETE /:id —— 删除                                                 */
/* ------------------------------------------------------------------ */

tunnelsRoutes.delete("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的隧道 ID" }, 400);

  const tunnel = await db.tunnel.findFirst({ where: { id, workspace_id: selectedWorkspace(c).id } });
  if (!tunnel) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(selectedWorkspace(c).role, "delete", tunnel.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  await db.$transaction([
    db.tunnelChain.deleteMany({ where: { tunnel_id: tunnel.id } }),
    db.tunnelTraffic.deleteMany({ where: { tunnel_id: tunnel.id } }),
    db.tunnel.delete({ where: { id: tunnel.id } }),
  ]);

  // WP15：删除后由 reconciler 拉齐 apply 命令，监听自然下线。
  return ok(c, { ok: true, id: tunnel.id });
});

/* ================================================================== */
/* WP11 — RELAY 隧道端点（`DEVELOPMENT.md` §7.13）                       */
/*                                                                      */
/* 端点（v3 前缀 `/v3` 与 legacy 分开，避免同一路径下两种语义打架）：     */
/*   GET    /v3/modes        可用模式（direct/relay）                    */
/*   POST   /v3/relay        创建 RELAY 隧道（explicit ingress +         */
/*                          egress/pool 选择）                          */
/*   GET    /v3/:id/state    隧道运行状态（五态 + revision + error）      */
/*   POST   /v3/:id/retry    仅 error → 重新编排（走 orchestrator）       */
/*   POST   /v3/:id/suspend  停用（desired→inactive）                    */
/*   POST   /v3/:id/resume   恢复（走 orchestrator 重新下发）             */
/*   DELETE /v3/:id          删除（撤两端 + 删行）                       */
/*                                                                      */
/* ── 边界（§7.13 铁律）──                                              */
/* 这些 handler **只做三件事**：解析入参、校验归属、调 tunnel-api 服务层； */
/* 所有会让 Agent 动起来的动作（retry/resume/delete 撤两端）统一经        */
/* {@link getOrchestrator} 拿到的进程级 orchestrator 收敛。本文件不出现   */
/* 第二个下发路径——`createCommand`/`dispatch*`/transport 一律不在这里。   */
/* 单测对这一点做静态锚定（`__tests__/tunnel-api.test.ts` 的 E 组）。     */
/* ================================================================== */

/** v3 端点统一把服务层错误翻成 HTTP 响应（状态码查表，不现场判）。 */
function apiError(
  c: Ctx,
  e: { ok: false; code: keyof typeof TUNNEL_API_ERROR_STATUS; message: string; apply_error_code?: string },
): Response {
  return c.json(
    { error: e.message, code: e.code, ...(e.apply_error_code ? { apply_error_code: e.apply_error_code } : {}) },
    TUNNEL_API_ERROR_STATUS[e.code] as 400 | 403 | 404 | 409 | 502 | 503,
  );
}

/** 读隧道 id 参数。 */
function readTunnelId(c: Ctx): number | Response {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "非法的隧道 ID" }, 400);
  return id;
}

tunnelsRoutes.get("/v3/modes", (c) => {
  // 前端依据它决定要不要渲染「出口节点组 / 出口池」两个字段。
  return ok(c, { modes: ["direct", "relay"], apply_statuses: ["pending", "applying", "active", "error", "suspended"] });
});

/* ------------------------------------------------------------------ */
/* GET /v3 —— RELAY 隧道列表（含五态 / 模式过滤）                         */
/* ------------------------------------------------------------------ */

tunnelsRoutes.get("/v3", async (c) => {
  requireUser(c);
  const workspace = selectedWorkspace(c);
  const q = c.req.query();
  const mode = q.tunnel_mode === undefined ? null : parseTunnelMode(q.tunnel_mode);
  if (q.tunnel_mode !== undefined && mode === null) return c.json({ error: "隧道模式非法（direct/relay）" }, 400);
  const applyStatus = parseApplyStatusFilter(q.apply_status);
  if (q.apply_status !== undefined && q.apply_status !== "all" && applyStatus === null) {
    return c.json({ error: "运行状态非法（pending/applying/active/error/suspended）" }, 400);
  }
  const keyword = String(q.keyword ?? "").trim();
  const result = await listTunnelsApi(
    {
      workspaceId: workspace.id,
      applyStatus,
      tunnelMode: mode as TunnelModeValue | null,
      keyword: keyword === "" ? undefined : keyword,
      page: Math.max(1, Number(q.page ?? 1) || 1),
      pageSize: Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20)),
    },
    { db: db as never, orchestrator: getOrchestrator() },
  );
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  return ok(c, { data: result.items, total: result.total, page, page_size });
});

/* ------------------------------------------------------------------ */
/* POST /v3/relay —— 创建 RELAY 隧道（走 orchestrator）                   */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/v3/relay", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  if (!canWorkspaceAction(workspace.role, "create")) return c.json({ error: "无权创建团队隧道" }, 403);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  /* ---- explicit ingress：入口组必须显式指定并校验归属 ---- */
  const inGroupId = Number(body.in_node_group_id);
  if (!Number.isInteger(inGroupId)) return c.json({ error: "必须指定入口节点组" }, 400);
  const inGroup = await db.nodeGroup.findUnique({ where: { id: inGroupId } });
  if (!inGroup) return c.json({ error: "入口节点组不存在" }, 404);
  if (inGroup.node_type !== "in" || !(await canUseNodeGroup(user.id, inGroup, "in", workspace.id, workspace.personalWorkspaceId)))
    return c.json({ error: "无权使用入口节点组" }, 403);

  /* ---- explicit egress：出口组（RELAY 必填）---- */
  const outGroupId = Number(body.out_node_group_id);
  if (!Number.isInteger(outGroupId)) return c.json({ error: "必须指定出口节点组（RELAY 双跳）" }, 400);
  const outGroup = await db.nodeGroup.findUnique({ where: { id: outGroupId } });
  if (!outGroup) return c.json({ error: "出口节点组不存在" }, 404);
  if (outGroup.node_type !== "out" || !(await canUseNodeGroup(user.id, outGroup, "out", workspace.id, workspace.personalWorkspaceId)))
    return c.json({ error: "无权使用出口节点组" }, 403);

  /* ---- egress pool 选择（可选；不传由编排器取 default 池）---- */
  let egressPoolId: number | null = null;
  if (body.egress_pool_id !== undefined && body.egress_pool_id !== null && body.egress_pool_id !== "") {
    const pid = Number(body.egress_pool_id);
    if (!Number.isInteger(pid) || pid <= 0) return c.json({ error: "出口池 ID 非法" }, 400);
    // 池挂在**节点**上（schema `EgressPool.node_id`），归属判定要再过一跳：
    // node.node_group_id 必须落在刚校验过的出口组内（否则用户可把出口
    // 甩到别人的节点上）。
    const pool = await db.egressPool.findUnique({
      where: { id: pid },
      include: { node: { select: { id: true, node_group_id: true, role: true } } },
    });
    if (!pool) return c.json({ error: "出口池不存在" }, 404);
    if (pool.node.node_group_id !== outGroup.id) {
      return c.json({ error: "出口池不属于所选出口节点组" }, 400);
    }
    if (pool.node.role !== "egress") {
      return c.json({ error: "出口池所在的节点不是出口节点" }, 400);
    }
    egressPoolId = pool.id;
  }

  /* ---- 监听端口（可选；不传由编排器在锁内分配）---- */
  let listenPort: number | null = null;
  if (body.listen_port !== undefined && body.listen_port !== null && body.listen_port !== "") {
    const port = Number(body.listen_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: "监听端口必须在 1-65535 之间" }, 400);
    }
    listenPort = port;
  }

  const tunnelType = String(body.tunnel_type ?? "tcp");

  const result = await createTunnelApi(
    {
      name: String(body.name ?? "").trim(),
      mode: "relay",
      userId: user.id,
      workspaceId: workspace.id,
      personalWorkspaceId: workspace.personalWorkspaceId,
      inNodeGroupId: inGroup.id,
      outNodeGroupId: outGroup.id,
      egressPoolId,
      listenPort,
      tunnelType,
    },
    { db: db as never, orchestrator: getOrchestrator() },
  );
  if (!result.ok) return apiError(c, result);

  // 编排器已把行落到终态；读回来给前端一个完整视图（含 revision）。
  const state = await getTunnelStateApi(result.tunnelId, workspace.id, { db: db as never });
  return ok(c, state.ok ? state.tunnel : { id: result.tunnelId, tunnel_mode: "relay" });
});

/* ------------------------------------------------------------------ */
/* GET /v3/:id/state —— 隧道运行状态（五态 / revision / error）            */
/* ------------------------------------------------------------------ */

tunnelsRoutes.get("/v3/:id/state", async (c) => {
  requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = readTunnelId(c);
  if (id instanceof Response) return id;

  const result = await getTunnelStateApi(id, workspace.id, { db: db as never });
  if (!result.ok) return apiError(c, result);
  return ok(c, {
    ...result.tunnel,
    // 待下发（applied < config）= 编排器正在收敛或 reconciler 未补发。
    sync_pending: result.tunnel.applied_revision < result.tunnel.config_revision,
  });
});

/* ------------------------------------------------------------------ */
/* POST /v3/:id/retry —— 仅 error 可重试（走 orchestrator 重新下发）        */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/v3/:id/retry", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = readTunnelId(c);
  if (id instanceof Response) return id;

  const existing = await db.tunnel.findFirst({ where: { id, workspace_id: workspace.id } });
  if (!existing) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(workspace.role, "update", existing.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const result = await runTunnelActionApi(id, "retry", workspace.id, {
    db: db as never,
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) return apiError(c, result);
  return ok(c, { ok: true, id, action: "retry", revision: result.revision, tunnel: result.tunnel });
});

/* ------------------------------------------------------------------ */
/* POST /v3/:id/suspend —— 停用（desired→inactive，标记期望）              */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/v3/:id/suspend", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = readTunnelId(c);
  if (id instanceof Response) return id;

  const existing = await db.tunnel.findFirst({ where: { id, workspace_id: workspace.id } });
  if (!existing) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(workspace.role, "update", existing.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const result = await runTunnelActionApi(id, "suspend", workspace.id, {
    db: db as never,
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) return apiError(c, result);
  return ok(c, { ok: true, id, action: "suspend", revision: result.revision, tunnel: result.tunnel });
});

/* ------------------------------------------------------------------ */
/* POST /v3/:id/resume —— 恢复（走 orchestrator 重新下发两端）             */
/* ------------------------------------------------------------------ */

tunnelsRoutes.post("/v3/:id/resume", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = readTunnelId(c);
  if (id instanceof Response) return id;

  const existing = await db.tunnel.findFirst({ where: { id, workspace_id: workspace.id } });
  if (!existing) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(workspace.role, "update", existing.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const result = await runTunnelActionApi(id, "resume", workspace.id, {
    db: db as never,
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) return apiError(c, result);
  return ok(c, { ok: true, id, action: "resume", revision: result.revision, tunnel: result.tunnel });
});

/* ------------------------------------------------------------------ */
/* DELETE /v3/:id —— 删除（orchestrator 撤两端 + 删行）                    */
/* ------------------------------------------------------------------ */

tunnelsRoutes.delete("/v3/:id", async (c) => {
  const user = requireUser(c);
  const workspace = selectedWorkspace(c);
  const id = readTunnelId(c);
  if (id instanceof Response) return id;

  const existing = await db.tunnel.findFirst({ where: { id, workspace_id: workspace.id } });
  if (!existing) return c.json({ error: "隧道不存在" }, 404);
  if (!canWorkspaceAction(workspace.role, "delete", existing.user_id === user.id))
    return c.json({ error: "无权操作该团队隧道" }, 403);

  const result = await runTunnelActionApi(id, "delete", workspace.id, {
    db: db as never,
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) return apiError(c, result);

  // WP15：删完由 reconciler 拉齐，让节点上的监听下线。
  return ok(c, { ok: true, id, action: "delete" });
});
