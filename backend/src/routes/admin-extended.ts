/**
 * 管理端扩展路由（W1）—— 前端 api.admin.* 中 admin.ts 未覆盖的 CRUD 与列表
 *
 * 挂载（app.ts）：app.route("/api/admin", adminExtendedRoutes);
 * 中间件由 app.ts 统一施加，与 adminRoutes 相同：
 *   app.use("/api/admin/*", adminRequired) → app.use("/api/admin/*", adminPermissionGuard)
 * 因此本模块内不再重复挂认证/权限中间件。
 *
 * 端点（与 admin.ts 不重复）：
 *   GET    /users                    管理端用户列表（api_key 脱敏）
 *   POST   /users                    创建用户
 *   PATCH  /users/:id                更新用户（PUT 同义）
 *   DELETE /users/:id                删除用户（级联清理关联记录）
 *   GET    /nodes                    节点列表
 *   POST   /nodes                    创建节点
 *   PATCH  /nodes/:id                更新节点（PUT 同义）
 *   DELETE /nodes/:id                删除节点
 *   GET    /node-groups              节点组列表（含 node_count / online_node_count）
 *   POST   /node-groups              创建节点组
 *   PATCH  /node-groups/:id          更新节点组（PUT 同义）
 *   DELETE /node-groups/:id          删除节点组
 *   GET    /plans                    套餐列表（含 node_groups）
 *   POST   /plans                    创建套餐
 *   PATCH  /plans/:id                更新套餐（PUT 同义）
 *   DELETE /plans/:id                删除套餐
 *   GET    /tunnels                  隧道全量列表
 *   GET    /orders?kind=all|plan|topup  订阅订单 + 充值订单（合并分页）
 *   GET    /tickets                  工单全量列表（含 user / replies）
 *
 * 响应封装：前端 lib/api.ts 的 request() 会剥掉 **一层** 顶层 `data`，与本目录下
 * tunnels/plans/topups/tickets/settings/node-groups 保持一致 ——
 *   列表 → { data: { data: rows, total, page, page_size }, total, page, limit, page_size }
 *   单条 → { data: row }
 *   错误 → { error: msg, message: msg }（message 兼容前端 ApiError 取文案）
 * 列表响应额外在顶层冗余 total/page/limit/page_size，兼容直接读顶层分页字段的调用方。
 *
 * 分页参数同时接受 limit（本文件契约）与 page_size（前端实际发送），上限 100。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { hashPassword, newApiKey } from "../auth.ts";
import { createPersonalWorkspace } from "../services/workspace.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import {
  collectAffectedNodeGroupsForUserDeletion,
  collectAffectedNodeGroupsForUsers,
  enqueueRefresh,
  refreshNodeGroups,
  refreshNodeGroupsForPlans,
  refreshNodeGroupsForUsers,
} from "../socket/config-refresh.ts";

export const adminExtendedRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** 统一错误响应：error 为契约字段，message 供前端 ApiError 取文案 */
function bad(c: Ctx, message: string, status: 400 | 403 | 404 | 409 = 400) {
  return c.json({ error: message, message }, status);
}

/** 包一层 data 的单条响应 */
function one(c: Ctx, data: unknown, status: 200 | 201 = 200) {
  return c.json({ data }, status);
}

/**
 * 列表响应：data.data 为前端 request() 剥壳后拿到的数组（= Paginated<T>），
 * 顶层冗余分页字段兼容 admin.ts 风格的读取方式。
 */
function listJson<T>(c: Ctx, rows: T[], total: number, page: number, limit: number) {
  return c.json({
    data: { data: rows, total, page, page_size: limit },
    total,
    page,
    limit,
    page_size: limit,
  });
}

interface PageQuery {
  page: number;
  limit: number;
  skip: number;
  take: number;
  keyword: string;
  status?: "active" | "inactive";
}

function readPage(c: Ctx): PageQuery {
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? q.page_size ?? 20) || 20));
  const rawStatus = q.status && q.status !== "all" ? String(q.status) : undefined;
  return {
    page,
    limit,
    skip: (page - 1) * limit,
    take: limit,
    keyword: String(q.keyword ?? "").trim(),
    status: rawStatus === "active" || rawStatus === "inactive" ? rawStatus : undefined,
  };
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** :id 路径参数 → 正整数，非法返回 null */
function readId(c: Ctx): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 字符串数组：接受数组或逗号/换行分隔字符串 */
function parseList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : String(v).split(/[\n,]/).map((x) => x.trim());
  const filtered = arr.filter(Boolean);
  return filtered.length ? filtered : null;
}

function parseIntList(v: unknown): number[] | null {
  const list = parseList(v);
  if (!list) return null;
  const nums = list.map((x) => Number(x)).filter((n) => Number.isInteger(n));
  return nums.length ? nums : null;
}

/** null → SQL NULL（Prisma 对 Json? 列要求 DbNull 而非裸 null） */
function jsonOrNull(value: unknown[] | null): never {
  return (value === null ? Prisma.DbNull : value) as never;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_VALUES = ["active", "inactive"] as const;
const NODE_TYPE_VALUES = ["in", "out"] as const;
const LOAD_BALANCE_VALUES = ["round", "rand", "fifo", "hash", "ll", "lc"] as const;
const BILLING_CYCLE_VALUES = ["month", "quarter", "half_year", "year", "lifetime"] as const;
const BYPASS_TYPE_VALUES = ["whitelist", "blacklist"] as const;

/** 取枚举字段：未提供返回 undefined；非法返回 null（调用方 400） */
function pickEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined | null {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : null;
}

/* ================================================================== */
/* 用户 —— /api/admin/users                                            */
/* ================================================================== */

adminExtendedRoutes.get("/users", async (c) => {
  const { page, limit, skip, take, keyword, status } = readPage(c);

  const where = {
    ...(status ? { status } : {}),
    ...(keyword
      ? { OR: [{ email: { contains: keyword } }, { uid: { contains: keyword } }] }
      : {}),
  } as Prisma.UserWhereInput;

  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { id: "desc" },
      skip,
      take,
      include: { admin_roles: true },
    }),
    db.user.count({ where }),
  ]);

  // api_key 脱敏：列表不下发凭据（原版语义）
  const data = rows.map(({ api_key, ...rest }) => rest);
  return listJson(c, data, total, page, limit);
});

adminExtendedRoutes.post("/users", async (c) => {
  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return bad(c, "邮箱不能为空");
  if (email.length > 120) return bad(c, "邮箱长度不能超过 120 字符");
  if (!EMAIL_RE.test(email)) return bad(c, "邮箱格式不正确");

  const dup = await db.user.findUnique({ where: { email } });
  if (dup) return bad(c, "该邮箱已存在", 409);

  const status = pickEnum(body.status, STATUS_VALUES);
  if (status === null) return bad(c, "状态不合法");

  const password = strOrNull(body.password);
  if (password !== null && password.length < 6) return bad(c, "密码至少 6 位");

  const parentId = numOrNull(body.parent_id);
  if (parentId !== null) {
    const parent = await db.user.findUnique({ where: { id: parentId } });
    if (!parent) return bad(c, "推荐人不存在", 404);
  }

  const balance = numOrNull(body.balance) ?? 0;
  const passwordHash = password === null ? null : await hashPassword(password);

  try {
    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          super_admin: Boolean(body.super_admin),
          balance,
          commission_balance: numOrNull(body.commission_balance) ?? 0,
          uid: strOrNull(body.uid),
          note: strOrNull(body.note),
          tg_id: strOrNull(body.tg_id),
          referral_commission_rate: numOrNull(body.referral_commission_rate),
          auto_renew: Boolean(body.auto_renew),
          status: status ?? "active",
          parent_id: parentId ?? undefined,
          api_key: newApiKey(),
        } as Prisma.UserUncheckedCreateInput,
      });
      await createPersonalWorkspace(tx, user);
      if (passwordHash) {
        await tx.userCredential.create({ data: { user_id: user.id, password: passwordHash } });
      }
      if (balance !== 0) {
        await tx.balanceLog.create({
          data: { user_id: user.id, balance, amount: balance, type: "admin_adjust" },
        });
      }
      return user;
    });
    return one(c, created, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return bad(c, "该邮箱已存在", 409);
    }
    throw e;
  }
});

/** PATCH / PUT /users/:id */
async function updateUser(c: Ctx) {
  const actor = requireUser(c);
  const id = readId(c);
  if (id === null) return bad(c, "非法的用户 ID");

  const target = await db.user.findUnique({ where: { id } });
  if (!target) return bad(c, "用户不存在", 404);

  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const data: Record<string, unknown> = {};

  if (body.email !== undefined) {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return bad(c, "邮箱不能为空");
    if (email.length > 120) return bad(c, "邮箱长度不能超过 120 字符");
    if (!EMAIL_RE.test(email)) return bad(c, "邮箱格式不正确");
    const dup = await db.user.findFirst({ where: { email, NOT: { id } } });
    if (dup) return bad(c, "该邮箱已被占用", 409);
    data.email = email;
  }
  if (body.status !== undefined) {
    const status = pickEnum(body.status, STATUS_VALUES);
    if (status === null) return bad(c, "状态不合法");
    data.status = status;
  }
  if (body.super_admin !== undefined) {
    // 防呆：不允许超管摘掉自己的超管标记（否则当前会话立即失去全部管理权限）
    if (actor.id === id && !body.super_admin) return bad(c, "不能取消当前登录账号的超管权限");
    data.super_admin = Boolean(body.super_admin);
  }
  if (body.uid !== undefined) data.uid = strOrNull(body.uid);
  if (body.note !== undefined) data.note = strOrNull(body.note);
  if (body.tg_id !== undefined) data.tg_id = strOrNull(body.tg_id);
  if (body.auto_renew !== undefined) data.auto_renew = Boolean(body.auto_renew);
  if (body.referral_commission_rate !== undefined) {
    data.referral_commission_rate = numOrNull(body.referral_commission_rate);
  }
  if (body.commission_balance !== undefined) {
    const cb = numOrNull(body.commission_balance);
    if (cb === null) return bad(c, "佣金余额必须是数字");
    data.commission_balance = cb;
  }

  // 余额：走 admin_adjust 流水（与 admin.ts / mock 一致）
  let newBalance: number | undefined;
  if (body.balance !== undefined) {
    const nb = numOrNull(body.balance);
    if (nb === null) return bad(c, "余额必须是数字");
    newBalance = Number(nb.toFixed(2));
    data.balance = newBalance;
  }

  let passwordHash: string | null = null;
  if (body.password !== undefined) {
    const pwd = strOrNull(body.password);
    if (!pwd) return bad(c, "密码不能为空");
    if (pwd.length < 6) return bad(c, "密码至少 6 位");
    passwordHash = await hashPassword(pwd);
  }

  const updated = await db.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id }, data: data as never });
    if (newBalance !== undefined && newBalance !== target.balance) {
      await tx.balanceLog.create({
        data: {
          user_id: id,
          balance: newBalance,
          amount: Number((newBalance - target.balance).toFixed(2)),
          type: "admin_adjust",
        },
      });
    }
    if (passwordHash) {
      await tx.userCredential.upsert({
        where: { user_id: id },
        create: { user_id: id, password: passwordHash },
        update: { password: passwordHash },
      });
    }
    return user;
  });

  // 停用/启用切换会改变 loadAvailableTunnels 的「有效隧道」集合
  // （user.status=active 是准入条件），必须刷新该用户名下隧道所在的全部节点组。
  if (data.status !== undefined && data.status !== target.status) {
    enqueueRefresh(refreshNodeGroupsForUsers([id]));
  }

  return one(c, updated);
}

adminExtendedRoutes.patch("/users/:id", updateUser);
adminExtendedRoutes.put("/users/:id", updateUser);

adminExtendedRoutes.delete("/users/:id", async (c) => {
  const actor = requireUser(c);
  const id = readId(c);
  if (id === null) return bad(c, "非法的用户 ID");
  if (actor.id === id) return bad(c, "不能删除当前登录账号");

  const target = await db.user.findUnique({ where: { id } });
  if (!target) return bad(c, "用户不存在", 404);

  // Team assets must be transferred/revoked explicitly, never deleted with an account.
  const teams = await db.workspaceMember.count({ where: { user_id: id, active: true, workspace: { kind: "team" } } });
  if (teams) return bad(c, "请先退出或转移用户所在的团队空间", 409);

  // An inactive membership does not authorize deletion of team-owned assets.
  const teamGroups = await db.nodeGroup.count({ where: { user_id: id, workspace: { kind: "team" } } });
  if (teamGroups) return bad(c, "请先转移或删除该用户创建的团队节点组", 409);

  const tunnelCount = await db.tunnel.count({ where: { user_id: id } });
  if (tunnelCount > 0) {
    return bad(c, `该用户仍有 ${tunnelCount} 条隧道，请先删除隧道`, 409);
  }

  // 级联删除会移除该用户的隧道/链路/节点组，故必须在事务前先算出受影响的节点组，
  // 事务后再刷新（否则查询隧道时数据已不存在）。
  const affectedGroups = await collectAffectedNodeGroupsForUserDeletion([id]);

  await db.$transaction(async (tx) => {
    // 解除角色绑定（隐式多对多）
    await tx.user.update({ where: { id }, data: { admin_roles: { set: [] } } });

    // 工单 + 本人工单下的全部回复（含管理员回复）
    const ticketIds = (
      await tx.ticket.findMany({ where: { user_id: id }, select: { id: true } })
    ).map((t) => t.id);
    await tx.ticketReply.deleteMany({ where: { user_id: id } });
    if (ticketIds.length) {
      await tx.ticketReply.deleteMany({ where: { ticket_id: { in: ticketIds } } });
    }
    await tx.ticket.deleteMany({ where: { user_id: id } });

    // 基础设施：隧道链 / 流量 / DNS / 节点 / 节点组 / 套餐绑定
    await tx.tunnelTraffic.deleteMany({ where: { tunnel: { user_id: id } } });
    await tx.tunnelChain.deleteMany({ where: { tunnel: { user_id: id } } });
    await tx.tunnel.deleteMany({ where: { user_id: id } });
    await tx.inNodeGroupDNS.deleteMany({ where: { in_node_group: { user_id: id } } });
    await tx.node.deleteMany({ where: { node_group: { user_id: id } } });
    await tx.planNodeGroup.deleteMany({ where: { node_group: { user_id: id } } });
    await tx.nodeGroup.deleteMany({ where: { user_id: id } });
    // Personal workspace records cascade after owned assets are removed.
    await tx.workspace.deleteMany({ where: { personal_user_id: id } });

    // 财务记录
    await tx.userPlan.deleteMany({ where: { user_id: id } });
    await tx.planOrder.deleteMany({ where: { user_id: id } });
    await tx.topupOrder.deleteMany({ where: { user_id: id } });
    await tx.balanceLog.deleteMany({ where: { user_id: id } });
    await tx.commissionLog.deleteMany({ where: { user_id: id } });
    await tx.withdrawRequest.deleteMany({ where: { user_id: id } });
    await tx.dNSProvider.deleteMany({ where: { user_id: id } });

    // 凭证 + 下级归属
    await tx.userCredential.deleteMany({ where: { user_id: id } });
    await tx.user.updateMany({ where: { parent_id: id }, data: { parent_id: null } });

    await tx.user.delete({ where: { id } });
  });

  // 用户已删除：刷新其隧道/节点组曾影响到的全部节点组（含引用其节点组的其他用户隧道组）。
  enqueueRefresh(refreshNodeGroups(affectedGroups));

  return one(c, { ok: true });
});

/* ================================================================== */
/* 节点 —— /api/admin/nodes                                            */
/* ================================================================== */

adminExtendedRoutes.get("/nodes", async (c) => {
  const { page, limit, skip, take, keyword, status } = readPage(c);

  const where = {
    ...(status ? { status } : {}),
    ...(keyword
      ? { OR: [{ node_id: { contains: keyword } }, { connect_ip: { contains: keyword } }] }
      : {}),
  } as Prisma.NodeWhereInput;

  const [rows, total] = await Promise.all([
    db.node.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "desc" }],
      skip,
      take,
      include: { node_group: { select: { id: true, name: true, node_type: true } } },
    }),
    db.node.count({ where }),
  ]);

  return listJson(c, rows, total, page, limit);
});

adminExtendedRoutes.post("/nodes", async (c) => {
  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const nodeId = strOrNull(body.node_id);
  if (!nodeId) return bad(c, "节点 ID 不能为空");
  if (nodeId.length > 64) return bad(c, "节点 ID 长度不能超过 64 字符");

  const connectIp = strOrNull(body.connect_ip);
  if (!connectIp) return bad(c, "连接 IP 不能为空");
  if (connectIp.length > 64) return bad(c, "连接 IP 长度不能超过 64 字符");

  const dup = await db.node.findUnique({ where: { node_id: nodeId } });
  if (dup) return bad(c, "节点 ID 已存在", 409);

  const status = pickEnum(body.status, STATUS_VALUES);
  if (status === null) return bad(c, "状态不合法");

  // node_group_id 在 schema 中非空：未提供时落到首个节点组
  let groupId = numOrNull(body.node_group_id);
  if (groupId === null) {
    const first = await db.nodeGroup.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
    if (!first) return bad(c, "请先创建节点组");
    groupId = first.id;
  } else {
    const group = await db.nodeGroup.findUnique({ where: { id: groupId } });
    if (!group) return bad(c, "节点组不存在", 404);
  }

  const weight = numOrNull(body.weight);
  if (weight !== null && weight < 0) return bad(c, "权重不合法");

  try {
    const created = await db.node.create({
      data: {
        node_id: nodeId,
        connect_ip: connectIp,
        node_group_id: groupId,
        weight: weight ?? undefined,
        version: strOrNull(body.version) ?? undefined,
        backup: body.backup === undefined ? undefined : Boolean(body.backup),
        status: status ?? "active",
        custom_line: body.custom_line === undefined ? undefined : strOrNull(body.custom_line),
        dns_status: body.dns_status === undefined ? undefined : Boolean(body.dns_status),
        order_by: numOrNull(body.order_by) ?? undefined,
      } as Prisma.NodeUncheckedCreateInput,
      include: { node_group: { select: { id: true, name: true, node_type: true } } },
    });
    return one(c, created, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return bad(c, "节点 ID 已存在", 409);
    }
    throw e;
  }
});

/** PATCH / PUT /nodes/:id */
async function updateNode(c: Ctx) {
  const id = readId(c);
  if (id === null) return bad(c, "非法的节点 ID");

  const node = await db.node.findUnique({ where: { id } });
  if (!node) return bad(c, "节点不存在", 404);

  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const data: Record<string, unknown> = {};

  if (body.node_id !== undefined) {
    const nodeId = strOrNull(body.node_id);
    if (!nodeId) return bad(c, "节点 ID 不能为空");
    if (nodeId.length > 64) return bad(c, "节点 ID 长度不能超过 64 字符");
    const dup = await db.node.findFirst({ where: { node_id: nodeId, NOT: { id } } });
    if (dup) return bad(c, "节点 ID 已存在", 409);
    data.node_id = nodeId;
  }
  if (body.connect_ip !== undefined) {
    const connectIp = strOrNull(body.connect_ip);
    if (!connectIp) return bad(c, "连接 IP 不能为空");
    data.connect_ip = connectIp;
  }
  if (body.node_group_id !== undefined) {
    const groupId = numOrNull(body.node_group_id);
    if (groupId === null) return bad(c, "必须指定节点组");
    const group = await db.nodeGroup.findUnique({ where: { id: groupId } });
    if (!group) return bad(c, "节点组不存在", 404);
    data.node_group_id = groupId;
  }
  if (body.status !== undefined) {
    const status = pickEnum(body.status, STATUS_VALUES);
    if (status === null) return bad(c, "状态不合法");
    data.status = status;
  }
  if (body.weight !== undefined) {
    const weight = numOrNull(body.weight);
    if (weight === null || weight < 0) return bad(c, "权重不合法");
    data.weight = weight;
  }
  if (body.version !== undefined) data.version = strOrNull(body.version) ?? "unknown";
  if (body.backup !== undefined) data.backup = Boolean(body.backup);
  if (body.custom_line !== undefined) data.custom_line = strOrNull(body.custom_line);
  if (body.dns_status !== undefined) data.dns_status = Boolean(body.dns_status);
  if (body.order_by !== undefined) {
    const orderBy = numOrNull(body.order_by);
    if (orderBy === null) return bad(c, "排序值不合法");
    data.order_by = orderBy;
  }

  const updated = await db.node.update({
    where: { id },
    data: data as never,
    include: { node_group: { select: { id: true, name: true, node_type: true } } },
  });
  return one(c, updated);
}

adminExtendedRoutes.patch("/nodes/:id", updateNode);
adminExtendedRoutes.put("/nodes/:id", updateNode);

adminExtendedRoutes.delete("/nodes/:id", async (c) => {
  const id = readId(c);
  if (id === null) return bad(c, "非法的节点 ID");

  const node = await db.node.findUnique({ where: { id } });
  if (!node) return bad(c, "节点不存在", 404);

  await db.node.delete({ where: { id } });
  return one(c, { ok: true });
});

/* ================================================================== */
/* 节点组 —— /api/admin/node-groups                                    */
/* ================================================================== */

/** 节点组列表项：补 node_count / online_node_count（前端类型要求） */
function withGroupStats(count: number, online: number) {
  return { node_count: count, online_node_count: online };
}

adminExtendedRoutes.get("/node-groups", async (c) => {
  const { page, limit, skip, take, keyword } = readPage(c);

  const where = {
    ...(keyword ? { OR: [{ name: { contains: keyword } }, { token: { contains: keyword } }] } : {}),
  } as Prisma.NodeGroupWhereInput;

  const [rows, total] = await Promise.all([
    db.nodeGroup.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "desc" }],
      skip,
      take,
      include: { _count: { select: { nodes: true } } },
    }),
    db.nodeGroup.count({ where }),
  ]);

  // 在线节点：schema 无运行态列，status=active 即视为在线（与用户侧 /node-groups 一致）
  const groupIds = rows.map((g) => g.id);
  const onlineRows = groupIds.length
    ? await db.node.groupBy({
        by: ["node_group_id"],
        where: { node_group_id: { in: groupIds }, status: "active" },
        _count: { _all: true },
      })
    : [];
  const onlineMap = new Map(onlineRows.map((r) => [r.node_group_id, r._count._all]));

  const data = rows.map(({ _count, ...g }) => ({
    ...g,
    ...withGroupStats(_count.nodes, onlineMap.get(g.id) ?? 0),
  }));

  return listJson(c, data, total, page, limit);
});

adminExtendedRoutes.post("/node-groups", async (c) => {
  const actor = requireUser(c);
  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const name = strOrNull(body.name);
  if (!name) return bad(c, "节点组名称不能为空");
  if (name.length > 60) return bad(c, "节点组名称长度不能超过 60 字符");

  const nodeType = pickEnum(body.node_type, NODE_TYPE_VALUES);
  if (nodeType === null) return bad(c, "节点类型必须是 in 或 out");

  const loadBalance = pickEnum(body.load_balance_type, LOAD_BALANCE_VALUES);
  if (loadBalance === null) return bad(c, "负载均衡类型不合法");

  const bypassType = pickEnum(body.bypass_type, BYPASS_TYPE_VALUES);
  if (bypassType === null) return bad(c, "bypass_type 不合法");

  // token：未提供则由 Prisma 默认 uuid() 生成；提供则校验格式与唯一
  const token = strOrNull(body.token);
  if (token !== null) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(token)) {
      return bad(c, "Token 只允许字母、数字、下划线和连字符（3-64 位）");
    }
    const dup = await db.nodeGroup.findUnique({ where: { token } });
    if (dup) return bad(c, "Token 已存在", 409);
  }

  const trafficRate = numOrNull(body.traffic_rate);
  if (trafficRate !== null && trafficRate < 0) return bad(c, "流量倍率不合法");

  const personalWorkspace = await db.workspace.findUniqueOrThrow({ where: { personal_user_id: actor.id } });
  const created = await db.nodeGroup.create({
    data: {
      name,
      user_id: actor.id,
      workspace_id: personalWorkspace.id,
      ...(token !== null ? { token } : {}),
      node_type: nodeType ?? "in",
      load_balance_type: loadBalance ?? "round",
      bypass_type: bypassType ?? "blacklist",
      port_range: body.port_range === undefined ? undefined : strOrNull(body.port_range),
      connect_ip: body.connect_ip === undefined ? undefined : strOrNull(body.connect_ip),
      traffic_rate: trafficRate ?? undefined,
      order_by: numOrNull(body.order_by) ?? undefined,
      allow_listen_protocol:
        body.allow_listen_protocol === undefined ? undefined : Boolean(body.allow_listen_protocol),
      admission: body.admission === undefined ? undefined : Boolean(body.admission),
      need_out_node_group:
        body.need_out_node_group === undefined ? undefined : Boolean(body.need_out_node_group),
      allow_listen_protocols: jsonOrNull(parseList(body.allow_listen_protocols)),
      allow_tunnel_types: jsonOrNull(parseList(body.allow_tunnel_types)),
      bypass_list: jsonOrNull(parseList(body.bypass_list)),
      block_protocols: jsonOrNull(parseList(body.block_protocols)),
      allow_out_node_groups: jsonOrNull(parseIntList(body.allow_out_node_groups)),
      allow_in_node_groups: jsonOrNull(parseIntList(body.allow_in_node_groups)),
    } as Prisma.NodeGroupUncheckedCreateInput,
  });

  return one(c, { ...created, ...withGroupStats(0, 0) }, 201);
});

/** PATCH / PUT /node-groups/:id */
async function updateNodeGroup(c: Ctx) {
  const id = readId(c);
  if (id === null) return bad(c, "非法的节点组 ID");

  const group = await db.nodeGroup.findUnique({ where: { id } });
  if (!group) return bad(c, "节点组不存在", 404);

  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = strOrNull(body.name);
    if (!name) return bad(c, "节点组名称不能为空");
    if (name.length > 60) return bad(c, "节点组名称长度不能超过 60 字符");
    data.name = name;
  }
  if (body.token !== undefined) {
    const token = strOrNull(body.token);
    if (!token) return bad(c, "Token 不能为空");
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(token)) {
      return bad(c, "Token 只允许字母、数字、下划线和连字符（3-64 位）");
    }
    // 唯一性校验必须排除自身，否则「不改 Token 直接保存」会误报重复
    const dup = await db.nodeGroup.findFirst({ where: { token, NOT: { id } } });
    if (dup) return bad(c, "Token 已存在", 409);
    data.token = token;
  }
  if (body.node_type !== undefined) {
    const nodeType = pickEnum(body.node_type, NODE_TYPE_VALUES);
    if (nodeType === null) return bad(c, "节点类型必须是 in 或 out");
    data.node_type = nodeType;
  }
  if (body.load_balance_type !== undefined) {
    const lb = pickEnum(body.load_balance_type, LOAD_BALANCE_VALUES);
    if (lb === null) return bad(c, "负载均衡类型不合法");
    data.load_balance_type = lb;
  }
  if (body.bypass_type !== undefined) {
    const bt = pickEnum(body.bypass_type, BYPASS_TYPE_VALUES);
    if (bt === null) return bad(c, "bypass_type 不合法");
    data.bypass_type = bt;
  }
  if (body.port_range !== undefined) data.port_range = strOrNull(body.port_range);
  if (body.connect_ip !== undefined) data.connect_ip = strOrNull(body.connect_ip);
  if (body.traffic_rate !== undefined) {
    const rate = numOrNull(body.traffic_rate);
    if (rate === null || rate < 0) return bad(c, "流量倍率不合法");
    data.traffic_rate = rate;
  }
  if (body.order_by !== undefined) {
    const orderBy = numOrNull(body.order_by);
    if (orderBy === null) return bad(c, "排序值不合法");
    data.order_by = orderBy;
  }
  for (const flag of ["allow_listen_protocol", "admission", "need_out_node_group"] as const) {
    if (body[flag] !== undefined) data[flag] = Boolean(body[flag]);
  }
  for (const listField of [
    "allow_listen_protocols",
    "allow_tunnel_types",
    "bypass_list",
    "block_protocols",
  ] as const) {
    if (body[listField] !== undefined) data[listField] = jsonOrNull(parseList(body[listField]));
  }
  for (const numListField of ["allow_out_node_groups", "allow_in_node_groups"] as const) {
    if (body[numListField] !== undefined) {
      data[numListField] = jsonOrNull(parseIntList(body[numListField]));
    }
  }

  const updated = await db.nodeGroup.update({ where: { id }, data: data as never });

  const [nodeCount, onlineCount] = await Promise.all([
    db.node.count({ where: { node_group_id: id } }),
    db.node.count({ where: { node_group_id: id, status: "active" } }),
  ]);
  return one(c, { ...updated, ...withGroupStats(nodeCount, onlineCount) });
}

adminExtendedRoutes.patch("/node-groups/:id", updateNodeGroup);
adminExtendedRoutes.put("/node-groups/:id", updateNodeGroup);

adminExtendedRoutes.delete("/node-groups/:id", async (c) => {
  const id = readId(c);
  if (id === null) return bad(c, "非法的节点组 ID");

  const group = await db.nodeGroup.findUnique({ where: { id } });
  if (!group) return bad(c, "节点组不存在", 404);

  const [nodeCount, tunnelCount] = await Promise.all([
    db.node.count({ where: { node_group_id: id } }),
    db.tunnel.count({ where: { OR: [{ in_node_group_id: id }, { out_node_group_id: id }] } }),
  ]);
  if (nodeCount > 0) return bad(c, "请先移除该节点组下的节点", 409);
  if (tunnelCount > 0) return bad(c, "该节点组仍被隧道引用，无法删除", 409);

  // 删除会移除本组的套餐绑定（plan_node_group）——属于「套餐-节点组绑定变更」，
  // 故先记录受影响的套餐，事务后刷新这些套餐的其余绑定组。
  const affectedPlanIds = (
    await db.planNodeGroup.findMany({ where: { node_group_id: id }, select: { plan_id: true } })
  ).map((r) => r.plan_id);

  await db.$transaction(async (tx) => {
    await tx.planNodeGroup.deleteMany({ where: { node_group_id: id } });
    await tx.tunnelChain.deleteMany({ where: { node_group_id: id } });
    await tx.inNodeGroupDNS.deleteMany({ where: { in_node_group_id: id } });
    await tx.nodeGroup.delete({ where: { id } });
  });

  // 刷新受影响套餐的订户隧道所在组（本组已删除，无需推送）。
  if (affectedPlanIds.length > 0) {
    enqueueRefresh(refreshNodeGroupsForPlans(affectedPlanIds));
  }

  return one(c, { ok: true });
});

/* ================================================================== */
/* 套餐 —— /api/admin/plans                                            */
/* ================================================================== */

/** 套餐 + 绑定节点组（前端 Plan.node_groups: {id,name}[]） */
function planView<T extends { node_groups?: { node_group: { id: number; name: string } }[] }>(
  row: T,
) {
  const { node_groups, ...rest } = row;
  return {
    ...rest,
    node_groups: (node_groups ?? []).map((ng) => ({ id: ng.node_group.id, name: ng.node_group.name })),
  };
}

adminExtendedRoutes.get("/plans", async (c) => {
  const { page, limit, skip, take, keyword, status } = readPage(c);

  const where = {
    ...(status ? { status } : {}),
    ...(keyword ? { name: { contains: keyword } } : {}),
  } as Prisma.PlanWhereInput;

  const [rows, total] = await Promise.all([
    db.plan.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "desc" }],
      skip,
      take,
      include: { node_groups: { include: { node_group: { select: { id: true, name: true } } } } },
    }),
    db.plan.count({ where }),
  ]);

  return listJson(c, rows.map(planView), total, page, limit);
});

/** 校验并同步套餐绑定的节点组（返回错误消息或 null） */
async function syncPlanNodeGroups(tx: Prisma.TransactionClient, planId: number, ids: number[]) {
  const found = await tx.nodeGroup.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const foundIds = new Set(found.map((g) => g.id));
  const missing = ids.find((id) => !foundIds.has(id));
  if (missing !== undefined) return `节点组 ${missing} 不存在`;

  await tx.planNodeGroup.deleteMany({ where: { plan_id: planId } });
  if (ids.length) {
    await tx.planNodeGroup.createMany({
      data: ids.map((node_group_id) => ({ plan_id: planId, node_group_id })),
    });
  }
  return null;
}

adminExtendedRoutes.post("/plans", async (c) => {
  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const name = strOrNull(body.name);
  if (!name) return bad(c, "套餐名称不能为空");
  if (name.length > 60) return bad(c, "套餐名称长度不能超过 60 字符");

  const price = numOrNull(body.price);
  if (price === null) return bad(c, "价格必须是数字");
  if (price < 0) return bad(c, "价格不能为负数");

  const status = pickEnum(body.status, STATUS_VALUES);
  if (status === null) return bad(c, "状态不合法");

  const cycle = pickEnum(body.billing_cycle, BILLING_CYCLE_VALUES);
  if (cycle === null) return bad(c, "账单周期不合法");

  const stock = numOrNull(body.stock);
  if (stock !== null && stock < 0) return bad(c, "库存不能为负数");

  const nodeGroupIds = parseIntList(body.node_group_ids) ?? [];

  let created;
  try {
    created = await db.$transaction(async (tx) => {
      const plan = await tx.plan.create({
        data: {
          name,
          price,
          description: strOrNull(body.description),
          original_price: numOrNull(body.original_price),
          max_tunnels: numOrNull(body.max_tunnels),
          traffic: numOrNull(body.traffic),
          ip_limit: numOrNull(body.ip_limit),
          client_limit: numOrNull(body.client_limit),
          bandwidth_limit: numOrNull(body.bandwidth_limit),
          whitelist_limit: numOrNull(body.whitelist_limit),
          setup_fee: numOrNull(body.setup_fee),
          stock,
          billing_cycle: cycle ?? "month",
          status: status ?? "active",
          order_by: numOrNull(body.order_by) ?? undefined,
          renewable: body.renewable === undefined ? undefined : Boolean(body.renewable),
          allow_custom_in_node_group: Boolean(body.allow_custom_in_node_group),
          allow_custom_out_node_group: Boolean(body.allow_custom_out_node_group),
          all_in_node_groups: Boolean(body.all_in_node_groups),
          all_out_node_groups: Boolean(body.all_out_node_groups),
        } as Prisma.PlanUncheckedCreateInput,
      });
      if (nodeGroupIds.length) {
        const err = await syncPlanNodeGroups(tx, plan.id, nodeGroupIds);
        if (err) throw new HTTPException(400, { message: err });
      }
      return plan;
    });
  } catch (e) {
    if (e instanceof HTTPException) return bad(c, e.message);
    throw e;
  }

  const full = await db.plan.findUniqueOrThrow({
    where: { id: created.id },
    include: { node_groups: { include: { node_group: { select: { id: true, name: true } } } } },
  });
  return one(c, planView(full), 201);
});

/** PATCH / PUT /plans/:id */
async function updatePlan(c: Ctx) {
  const id = readId(c);
  if (id === null) return bad(c, "非法的套餐 ID");

  const plan = await db.plan.findUnique({ where: { id } });
  if (!plan) return bad(c, "套餐不存在", 404);

  const body = await readBody(c);
  if (!body) return bad(c, "参数错误");

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = strOrNull(body.name);
    if (!name) return bad(c, "套餐名称不能为空");
    if (name.length > 60) return bad(c, "套餐名称长度不能超过 60 字符");
    data.name = name;
  }
  if (body.price !== undefined) {
    const price = numOrNull(body.price);
    if (price === null) return bad(c, "价格必须是数字");
    if (price < 0) return bad(c, "价格不能为负数");
    data.price = price;
  }
  if (body.status !== undefined) {
    const status = pickEnum(body.status, STATUS_VALUES);
    if (status === null) return bad(c, "状态不合法");
    data.status = status;
  }
  if (body.billing_cycle !== undefined) {
    const cycle = pickEnum(body.billing_cycle, BILLING_CYCLE_VALUES);
    if (cycle === null) return bad(c, "账单周期不合法");
    data.billing_cycle = cycle;
  }
  if (body.stock !== undefined) {
    const stock = numOrNull(body.stock);
    if (stock !== null && stock < 0) return bad(c, "库存不能为负数");
    data.stock = stock;
  }
  for (const numField of [
    "original_price",
    "max_tunnels",
    "traffic",
    "ip_limit",
    "client_limit",
    "bandwidth_limit",
    "whitelist_limit",
    "setup_fee",
  ] as const) {
    if (body[numField] !== undefined) data[numField] = numOrNull(body[numField]);
  }
  if (body.order_by !== undefined) {
    const orderBy = numOrNull(body.order_by);
    if (orderBy === null) return bad(c, "排序值不合法");
    data.order_by = orderBy;
  }
  if (body.description !== undefined) data.description = strOrNull(body.description);
  for (const flag of [
    "renewable",
    "allow_custom_in_node_group",
    "allow_custom_out_node_group",
    "all_in_node_groups",
    "all_out_node_groups",
  ] as const) {
    if (body[flag] !== undefined) data[flag] = Boolean(body[flag]);
  }

  const nodeGroupIds =
    body.node_group_ids === undefined ? undefined : parseIntList(body.node_group_ids) ?? [];

  // 事务前读取「旧」绑定与状态，用于变更后判定受影响的节点组。
  const bindingChanged = nodeGroupIds !== undefined;
  const configAffectingChange =
    (data.status !== undefined && data.status !== plan.status) ||
    bindingChanged ||
    (body.all_in_node_groups !== undefined && Boolean(body.all_in_node_groups) !== plan.all_in_node_groups) ||
    (body.all_out_node_groups !== undefined && Boolean(body.all_out_node_groups) !== plan.all_out_node_groups);
  const oldBoundGroupIds = bindingChanged || configAffectingChange
    ? (
        await db.planNodeGroup.findMany({ where: { plan_id: id }, select: { node_group_id: true } })
      ).map((r) => r.node_group_id)
    : [];

  try {
    await db.$transaction(async (tx) => {
      await tx.plan.update({ where: { id }, data: data as never });
      if (nodeGroupIds !== undefined) {
        const err = await syncPlanNodeGroups(tx, id, nodeGroupIds);
        if (err) throw new HTTPException(400, { message: err });
      }
    });
  } catch (e) {
    if (e instanceof HTTPException) return bad(c, e.message);
    throw e;
  }

  // 套餐停用/启用、全组放行开关、或套餐-节点组绑定变化，都会改变
  // 订阅该套餐用户隧道的「进/出」资格 → 刷新订户隧道所在组 + 绑定前后涉及的组。
  if (configAffectingChange) {
    enqueueRefresh(
      refreshNodeGroupsForPlans([id], [...oldBoundGroupIds, ...(nodeGroupIds ?? [])]),
    );
  }

  const full = await db.plan.findUniqueOrThrow({
    where: { id },
    include: { node_groups: { include: { node_group: { select: { id: true, name: true } } } } },
  });
  return one(c, planView(full));
}

adminExtendedRoutes.patch("/plans/:id", updatePlan);
adminExtendedRoutes.put("/plans/:id", updatePlan);

adminExtendedRoutes.delete("/plans/:id", async (c) => {
  const id = readId(c);
  if (id === null) return bad(c, "非法的套餐 ID");

  const plan = await db.plan.findUnique({ where: { id } });
  if (!plan) return bad(c, "套餐不存在", 404);

  const [userPlanCount, orderCount] = await Promise.all([
    db.userPlan.count({ where: { plan_id: id } }),
    db.planOrder.count({ where: { plan_id: id } }),
  ]);
  if (userPlanCount > 0) return bad(c, "该套餐仍有用户订阅，无法删除", 409);
  if (orderCount > 0) return bad(c, "该套餐存在历史订单，无法删除", 409);

  // 删除前先取套餐绑定的节点组 id（删除后 plan_node_group 记录已不存在）。
  const boundGroupIds = (
    await db.planNodeGroup.findMany({ where: { plan_id: id }, select: { node_group_id: true } })
  ).map((r) => r.node_group_id);

  await db.$transaction(async (tx) => {
    await tx.planNodeGroup.deleteMany({ where: { plan_id: id } });
    await tx.plan.delete({ where: { id } });
  });

  // 套餐删除：若存在漏网的订阅/引用，也要把相关节点组刷新一遍（防御性，通常为空）。
  enqueueRefresh(refreshNodeGroupsForPlans([id], boundGroupIds));

  return one(c, { ok: true });
});

/* ================================================================== */
/* 隧道（管理端全量）—— /api/admin/tunnels                            */
/* ================================================================== */

adminExtendedRoutes.get("/tunnels", async (c) => {
  const { page, limit, skip, take, keyword, status } = readPage(c);
  const q = c.req.query();

  const where = {
    ...(status ? { status } : {}),
    ...(keyword ? { name: { contains: keyword } } : {}),
    ...(numOrNull(q.user_id) !== null ? { user_id: numOrNull(q.user_id)! } : {}),
  } as Prisma.TunnelWhereInput;

  const [rows, total] = await Promise.all([
    db.tunnel.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "desc" }],
      skip,
      take,
      include: {
        user: { select: { id: true, email: true } },
        in_node_group: { select: { id: true, name: true, node_type: true } },
        out_node_group: { select: { id: true, name: true, node_type: true } },
      },
    }),
    db.tunnel.count({ where }),
  ]);

  // 运行态列不存在于 schema：status=active 近似为 online（与用户侧 tunnels 一致）
  const data = rows.map((t) => ({ ...t, online: t.status === "active" }));
  return listJson(c, data, total, page, limit);
});

/* ================================================================== */
/* 订单（订阅 + 充值合并）—— /api/admin/orders                         */
/* ================================================================== */

adminExtendedRoutes.get("/orders", async (c) => {
  const { page, limit, keyword, status } = readPage(c);
  const q = c.req.query();
  const kind = ["all", "plan", "topup"].includes(String(q.kind ?? "all"))
    ? String(q.kind ?? "all")
    : "all";

  const planWhere = {
    ...(keyword ? { plan: { name: { contains: keyword } } } : {}),
  } as Prisma.PlanOrderWhereInput;

  // 充值订单有 status 列；订阅订单没有，故 status 过滤只作用于充值侧
  const topupWhere = {
    ...(status ? { status } : {}),
    ...(keyword ? { order_id: { contains: keyword } } : {}),
  } as Prisma.TopupOrderWhereInput;

  const [planOrders, topupOrders] = await Promise.all([
    kind === "topup"
      ? Promise.resolve([])
      : db.planOrder.findMany({
          where: planWhere,
          include: {
            user: { select: { id: true, email: true } },
            plan: { select: { id: true, name: true, price: true, billing_cycle: true } },
          },
        }),
    kind === "plan"
      ? Promise.resolve([])
      : db.topupOrder.findMany({
          where: topupWhere,
          include: {
            user: { select: { id: true, email: true } },
            payment: { select: { id: true, name: true, method: true } },
          },
        }),
  ]);

  // 两表结构不同，统一加 kind 标记后按时间倒序合并分页
  const merged = [
    ...planOrders.map((o) => ({ ...o, kind: "plan" as const })),
    ...topupOrders.map((o) => ({ ...o, kind: "topup" as const })),
  ].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id - a.id,
  );

  const total = merged.length;
  const data = merged.slice((page - 1) * limit, (page - 1) * limit + limit);
  return listJson(c, data, total, page, limit);
});

/* ================================================================== */
/* 工单（管理端全量）—— /api/admin/tickets                             */
/* ================================================================== */

adminExtendedRoutes.get("/tickets", async (c) => {
  const { page, limit, skip, take, keyword, status } = readPage(c);
  const q = c.req.query();

  const where = {
    ...(status ? { status } : {}),
    ...(keyword ? { title: { contains: keyword } } : {}),
    ...(numOrNull(q.user_id) !== null ? { user_id: numOrNull(q.user_id)! } : {}),
  } as Prisma.TicketWhereInput;

  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { id: "desc" },
      skip,
      take,
      include: {
        user: { select: { id: true, email: true } },
        replies: { orderBy: { id: "asc" } },
      },
    }),
    db.ticket.count({ where }),
  ]);

  return listJson(c, rows, total, page, limit);
});
