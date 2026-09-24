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
import { pushNodeConfig } from "../socket/config-pusher.ts";
import { canUseNodeGroup } from "../services/node-group-access.ts";
import { canWorkspaceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import {
  countWorkspaceTunnels,
  sumWorkspaceTraffic,
  withWorkspaceQuotaLock,
} from "../services/policy-service.ts";
import { checkTunnelCreation } from "../services/capability-policy.ts";

export const tunnelsRoutes = new Hono<{ Variables: AppVariables }>();

// Every user route selects a verified workspace; missing header means personal space.
tunnelsRoutes.use("*", async (c, next) => {
  const isCreate = c.req.method === "POST" && /^\/api\/tunnels\/?$/.test(c.req.path);
  c.set("workspace", await resolveWorkspaceAccess(c, isCreate ? "create" : "read"));
  await next();
});

/**
 * 推送隧道所属节点组的配置（节点在线时立即生效）。
 * 只推「入/出组」——原版语义：入口组负责监听，出口组负责转发目标。
 *
 * force: true —— 隧道侧强制下发，不走指纹去重。原因：隧道是用户直接操作的对象，
 * 即便某些字段不影响生成配置的指纹（例如备注），用户也有权期待「改了就看到」；
 * 且去重命中时 register 首推已由 index.ts 单独 force，二者不冲突。
 */
function pushTunnelConfig(t: {
  in_node_group_id: number;
  out_node_group_id: number | null;
}): void {
  void pushNodeConfig(t.in_node_group_id, { force: true }).catch(() => {});
  if (t.out_node_group_id) void pushNodeConfig(t.out_node_group_id, { force: true }).catch(() => {});
}

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

  // 推送配置到入口/出口节点组（节点在线时立即生效）
  pushTunnelConfig(created);

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

  // 换节点组时，旧组的配置也要刷新（移除该隧道的监听）
  if (updated.in_node_group_id !== tunnel.in_node_group_id) {
    void pushNodeConfig(tunnel.in_node_group_id).catch(() => {});
  }
  if (updated.out_node_group_id !== tunnel.out_node_group_id && tunnel.out_node_group_id) {
    void pushNodeConfig(tunnel.out_node_group_id).catch(() => {});
  }
  pushTunnelConfig(updated);

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

  // 状态变化影响 loadAvailableTunnels（只推 active），必须推送
  pushTunnelConfig(updated);

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

  // 删除后刷新相关节点组（节点上的监听需要下线）
  pushTunnelConfig(tunnel);

  return ok(c, { ok: true, id: tunnel.id });
});
