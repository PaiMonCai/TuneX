/**
 * 管理端路由
 * 全部挂载在 /api/admin/* 之下，由 app.ts 统一施加
 *   adminRequired → adminPermissionGuard
 * 具体资源路径需与 permissions.ts 的 apiPrefixes 对齐，否则 fail-closed 403。
 */
import { Hono } from "hono";
import { SystemConfigName } from "@prisma/client";
import { db } from "../db.ts";
import { systemConfig } from "../services/config.ts";
import { licenseService } from "../services/license.ts";
import { createNodeEnrollment } from "../services/node-enrollment.ts";
import {
  credentialErrorStatus,
  issueNodeCredential,
  revokeNodeCredential,
  rotateNodeCredential,
} from "../services/node-credential.ts";
import {
  ADMIN_RESOURCES,
  sanitizePermissions,
  getEffectiveAccess,
} from "../permissions.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const adminRoutes = new Hono<{ Variables: AppVariables }>();

/* ------------------------------------------------------------------ *
 * dashboard — /api/admin/stats*  → key: dashboard
 * ------------------------------------------------------------------ */
adminRoutes.get("/stats", async (c) => {
  const [users, tunnels, nodes, plans, orders, onlineNodes] = await Promise.all([
    db.user.count(),
    db.tunnel.count(),
    db.node.count(),
    db.plan.count(),
    db.planOrder.count(),
    db.node.count({ where: { status: "active" } }),
  ]);
  return c.json({
    data: {
      user_count: users,
      tunnel_count: tunnels,
      node_count: nodes,
      online_node_count: onlineNodes,
      plan_count: plans,
      order_count: orders,
      today_revenue: 0,
      today_traffic: 0,
      revenue_trend: [],
      tunnel_type_distribution: [],
    },
  });
});

adminRoutes.get("/plan/stats", async (c) =>
  c.json({ data: { plans: await db.plan.count(), user_plans: await db.userPlan.count() } }),
);

adminRoutes.get("/topup/stats", async (c) =>
  c.json({ data: { topups: await db.topupOrder.count() } }),
);

/* ------------------------------------------------------------------ *
 * users — /api/admin/user*  → key: users
 * ------------------------------------------------------------------ */
adminRoutes.get("/user", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const [rows, total] = await Promise.all([
    db.user.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { id: "desc" },
      include: { admin_roles: true },
    }),
    db.user.count(),
  ]);
  // api_key 脱敏（原版列表响应剔除 api_key）；SEC-02 起哈希列同样剔除——
  // 管理端列表绝不下发任何可用凭据或其摘要。
  const data = rows.map(
    ({ api_key, subscription_key, api_key_hash, subscription_key_hash, ...rest }) => rest,
  );
  return c.json({ data, total, page, limit });
});

/* ------------------------------------------------------------------ *
 * node_groups — /api/admin/node/group* → key: node_groups
 * 注意 /api/admin/node/group/summary → $staff（共享前缀，任何 admin 可读）
 * ------------------------------------------------------------------ */
adminRoutes.get("/node/group/summary", async (c) =>
  c.json({ data: { total: await db.nodeGroup.count() } }),
);

adminRoutes.get("/node/group", async (c) => {
  const rows = await db.nodeGroup.findMany({ orderBy: { id: "desc" } });
  return c.json({ data: rows, total: rows.length });
});

/* ------------------------------------------------------------------ *
 * nodes — /api/admin/node* → key: nodes
 * ------------------------------------------------------------------ */
adminRoutes.get("/node", async (c) => {
  // **必须用 select 白名单**，不能 `findMany()` 全字段下发：
  // `node_credential_hash` 是节点长期凭据的 sha256 摘要，它没有理由进入 SSR payload /
  // 浏览器内存。凭据状态由 `credential_*` 那几列表达（是否签发/是否吊销/轮换时间），
  // 列表页需要的信息一个不少。R5-B 复核在真机响应里实测到过这个字段（P3-8）。
  const rows = await db.node.findMany({
    orderBy: { id: "desc" },
    select: {
      id: true, node_id: true, agent_id: true, weight: true, status: true, role: true,
      connect_ip: true, version: true, backup: true, order_by: true, custom_line: true,
      dns_status: true, created_at: true, updated_at: true, node_group_id: true,
      last_seen_at: true, port_range_min: true, port_range_max: true, lb_strategy: true,
      credential_rotated_at: true, credential_revoked: true, credential_last_rejected_at: true,
      lifecycle: true, lifecycle_updated_at: true, lifecycle_note: true,
    },
  });
  return c.json({ data: rows, total: rows.length });
});

/* ------------------------------------------------------------------ *
 * node credential — /api/admin/node/:id/credential*（）
 *
 * 路径已落在 `nodes` 资源的 apiPrefixes（`/admin/node`）上，因此
 * adminPermissionGuard 自动要求 nodes 资源的 write 权限；
 * 轮换/撤销是**敏感的凭据写操作**，另在 middlewares/rate-limit.ts 配了
 * `node-credential-rotation` 专属低额度规则（60s/5 次，user 维度）。
 *
 * 明文的唯一出口：issue/rotate 的 200 响应体。审计侧只留 method/path/status/ip，
 * services/audit.ts 的 SENSITIVE_RE 命中 token/credential 亦会丢 metadata；本文件不写日志。
 * ------------------------------------------------------------------ */

/** 节点 id 解析：面板侧用数字主键（db.id）；字符串 node_id 走 :key 变体。 */
async function resolveNodeIdParam(param: string): Promise<number | null> {
  const num = Number(param);
  if (Number.isInteger(num) && num > 0) {
    const row = await db.node.findUnique({ where: { id: num }, select: { id: true } });
    return row?.id ?? null;
  }
  const row = await db.node.findUnique({ where: { node_id: param }, select: { id: true } });
  return row?.id ?? null;
}

/** 节点凭据错误 → HTTP 状态码（401 之外的错误走这里，统一 4xx）。 */
function credentialHttpStatus(e: unknown): 404 | 409 {
  return credentialErrorStatus(e) === 409 ? 409 : 404;
}

adminRoutes.post("/node/:id/enrollment", async (c) => {
  const nodeDbId = await resolveNodeIdParam(c.req.param("id"));
  if (nodeDbId === null) return c.json({ error: "节点不存在" }, 404);
  try {
    const enrollment = await createNodeEnrollment(nodeDbId);
    return c.json({ data: enrollment }, 201);
  } catch {
    return c.json({ error: "节点不存在" }, 404);
  }
});

adminRoutes.post("/node/:id/credential", async (c) => {
  const nodeDbId = await resolveNodeIdParam(c.req.param("id"));
  if (nodeDbId === null) return c.json({ error: "节点不存在" }, 404);
  try {
    const { plaintext, node_id, node_key } = await issueNodeCredential(nodeDbId);
    // 明文只在这里出现一次。响应之外不落任何存储/日志。
    return c.json({
      data: { credential: plaintext, node_id, node_key, issued_at: new Date().toISOString() },
    });
  } catch (e) {
    if (credentialErrorStatus(e) === null) throw e;
    return c.json(
      {
        error:
          credentialErrorStatus(e) === 409
            ? "该节点已有有效凭据，请改用轮换"
            : "节点不存在",
      },
      credentialHttpStatus(e),
    );
  }
});

adminRoutes.post("/node/:id/credential/rotate", async (c) => {
  const nodeDbId = await resolveNodeIdParam(c.req.param("id"));
  if (nodeDbId === null) return c.json({ error: "节点不存在" }, 404);
  try {
    const { plaintext, node_id, node_key } = await rotateNodeCredential(nodeDbId);
    return c.json({
      data: { credential: plaintext, node_id, node_key, rotated_at: new Date().toISOString() },
    });
  } catch (e) {
    if (credentialErrorStatus(e) === null) throw e;
    return c.json({ error: "节点不存在或尚未签发凭据" }, credentialHttpStatus(e));
  }
});

adminRoutes.post("/node/:id/credential/revoke", async (c) => {
  const nodeDbId = await resolveNodeIdParam(c.req.param("id"));
  if (nodeDbId === null) return c.json({ error: "节点不存在" }, 404);
  try {
    const { node_id, node_key } = await revokeNodeCredential(nodeDbId);
    return c.json({ data: { revoked: true, node_id, node_key } });
  } catch (e) {
    if (credentialErrorStatus(e) === null) throw e;
    return c.json({ error: "节点不存在" }, credentialHttpStatus(e));
  }
});

/* ------------------------------------------------------------------ *
 * settings — /api/admin/system/config* → key: settings
 * ------------------------------------------------------------------ */
const SECRET_CONFIG_NAMES = new Set<string>(["SMTP_PASS", "RESEND_API_KEY", "CHATWOOT_TOKEN"]);
const CONFIG_NAMES = new Set<string>(Object.values(SystemConfigName));

/**
 * **部署级配置键**（N-F1）：这些键的真值来自**进程环境变量**，`config` 表里的行**没有任何读者**。
 *
 * ── 为什么必须显式拒绝，而不是"接受后忽略" ──
 * 之前 `SMTP_*` 可以写、`PUT` 还回 200：运维在管理端点一下"保存"，界面显示成功，于是合理相信
 * "邮件配好了"，而 `services/mail.ts` 只读 `env.ts` 的 `mail` 段（`process.env.SMTP_*`）——
 * 那个表单在**主动骗人**。让一封验证邮件永远发不出去，比"页面少一个输入框"严重得多。
 *
 * 所以：**不列、不写、写明理由**（错误消息里给具体变量名与部署文档入口）。
 * 历史行（如果库里曾经写过）**留在原地不删**（删是破坏性动作），只是从此不再被当作可配置项。
 *
 * 为什么现在不做"让邮件读 DB 配置"：`isConfigured()` 是**同步契约**，而 panel 与 worker 是
 * 两个进程、都在发信（验证/重置在 panel，公告/事实通知在 worker）。要让 DB 配置真正生效，
 * 需要"同步快照 + 跨进程失效"（Redis 发布订阅）**外加** SMTP_PASS 的封存治理 —— 那是一个
 * 独立切片，不是一个缺陷修复。见 `docs/production-deploy.md` 的邮件配置段。
 */
const DEPLOYMENT_LEVEL_CONFIG_NAMES = new Set<string>([
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
]);

/**
 * **未接线配置键**（task-33 的穷举审计结论）：既**没有生产读者**，**也不是**部署级 env 提供的。
 * 写进去不会有任何效果 —— 所以同样"不列、不写、写明理由"，理由里说清"该能力尚未接线"。
 *
 * 审计口径（每个键都按这个口径查过）：
 *  · 在 `backend/src`、`web/src`、`agent/` 三处全文检索该键名（排除 admin.ts / 测试 / mock / 本文件的文案）；
 *  · **只在 `env.ts` 里被读不算**该 DB 键有读者（env 与 config 表是两个来源）；
 *  · 命中必须是一个真的"消费点"（服务/路由/前端），注释与类型定义不算。
 *
 * 逐键证据（`文件:行`，均为"零命中"或"命中只是注释/类型"）：
 *  · `EMAIL_PROVIDER` / `RESEND_API_KEY` / `RESEND_FROM` —— 零命中；`mail.ts` 只走 SMTP，
 *    仓库里没有任何 resend 客户端（`grep -rn "resend" src` 只命中 reconciler 的"重发"字样）；
 *  · `CHATWOOT_BASE_URL` / `CHATWOOT_TOKEN` —— 全仓（含 `web/src`）零命中，客服组件不存在；
 *  · `REFERRAL_COMMISSION_RATE` / `REFERRAL_FIRST_ONLY` / `REFERRAL_MODE` —— 零命中；
 *    真实生效的是**每用户字段** `user.referral_commission_rate`（`routes/admin-extended.ts:258/321`），
 *    全局默认值没有任何读取点（`REFERRAL_MODE` 只在 `services/payment/order.ts:351` 的一句注释里出现）；
 *  · `MIN_WITHDRAW_AMOUNT` / `WITHDRAW_METHODS` —— 零命中；提现只有 admin 资源键与
 *    `withdrawRequest` 的清理（`routes/admin-extended.ts:496`），没有提现流程读这两个键；
 *  · `LIMIT_SCOPE` —— 零命中（额度作用域判定走 `services/*` 里的显式逻辑，不读这个键）；
 *  · `AUTO_UPDATE_AGENT` / `OBSERVER_PERIOD` —— 零命中（Agent 侧也没有同名读取）。
 */
const UNWIRED_CONFIG_NAMES = new Set<string>([
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "CHATWOOT_BASE_URL",
  "CHATWOOT_TOKEN",
  "REFERRAL_COMMISSION_RATE",
  "REFERRAL_FIRST_ONLY",
  "REFERRAL_MODE",
  "MIN_WITHDRAW_AMOUNT",
  "WITHDRAW_METHODS",
  "LIMIT_SCOPE",
  "AUTO_UPDATE_AGENT",
  "OBSERVER_PERIOD",
]);

/**
 * **已废弃配置键**：公告的真相已迁到 `announcement` 表（只读迁移
 * `20261033000000_v5_wp18_announcements`），免认证下发面也已移除它们（`routes/public.ts:161-163`）。
 * 现在**没有任何读取点**，所以写入同样是"写了不生效"。
 *
 * 与未接线键的区别：这三个键**保留在列表里但只读**——原代码注释写明了它们的用途是
 * "旧值要能看见/清理"，直接不列会让旧值变得不可见（审计价值）。写操作一律拒绝：
 * 想改公告请用公告功能，想清理旧行请走运维（本接口不做破坏性动作）。
 */
const DEPRECATED_CONFIG_NAMES = new Set<string>(["NOTICE", "NOTICE_POPUP", "NOTICE_POPUP_INTERVAL_HOURS"]);

/** 拒绝写入时给出的具体变量名（给人抄，而不是一个泛化的 400）。 */
const DEPLOYMENT_LEVEL_ENV_NAMES: readonly string[] = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_SECURE",
];

adminRoutes.get("/system/config", async (c) => {
  const rows = await systemConfig.listAll();
  return c.json({
    data: rows
      // 部署级键与未接线键都不列：它们在这里既写不了、也不生效，列出来只会让人以为能配。
      .filter((row) => !DEPLOYMENT_LEVEL_CONFIG_NAMES.has(row.name) && !UNWIRED_CONFIG_NAMES.has(row.name))
      .map((row) => {
        const base = SECRET_CONFIG_NAMES.has(row.name)
          ? { ...row, value: "", secret_configured: row.value.length > 0 }
          : row;
        // 废弃键：值仍可见（旧值审计/迁移需要），但**只读**——界面上不给保存按钮。
        return DEPRECATED_CONFIG_NAMES.has(row.name)
          ? { ...base, read_only: true, read_only_reason: "deprecated" as const }
          : base;
      }),
  });
});

adminRoutes.put("/system/config/:name", async (c) => {
  const name = c.req.param("name");
  if (DEPLOYMENT_LEVEL_CONFIG_NAMES.has(name)) {
    // 明确拒绝（不是"接受后忽略"）：这个响应本身就要能告诉脚本/运维"该去哪儿改"。
    return c.json(
      {
        error:
          "SMTP_* 是部署级配置：邮件发送读取的是进程环境变量（env.ts 的 mail 段），管理端不接受写入。" +
          `请在部署环境里设置 ${DEPLOYMENT_LEVEL_ENV_NAMES.join(" / ")}（见 docs/production-deploy.md 的邮件配置段）。`,
        code: "deployment_level_config",
        env_names: DEPLOYMENT_LEVEL_ENV_NAMES,
      },
      400,
    );
  }
  if (UNWIRED_CONFIG_NAMES.has(name)) {
    // 明确拒绝：这个键**没有任何生产读者**，写进去只会让"保存成功"变成一句空话。
    return c.json(
      {
        error:
          `${name} 目前没有任何生产读者（该能力尚未接线）：管理端不接受写入，写了也不会生效。` +
          "等它有了读取点（服务/路由）再按需要的形态接线；请不要用这个接口做'先存下来以后再说'。",
        code: "config_not_wired",
      },
      400,
    );
  }
  if (DEPRECATED_CONFIG_NAMES.has(name)) {
    return c.json(
      {
        error:
          `${name} 已废弃：公告的真相在 announcement 表（迁移 20261033000000_v5_wp18_announcements），` +
          "免认证下发面也已不再读它。管理端不接受写入；要发公告请用公告功能，历史值仅保留供审计。",
        code: "config_deprecated",
      },
      400,
    );
  }
  if (!CONFIG_NAMES.has(name)) return c.json({ error: "未知配置项" }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.value !== "string") return c.json({ error: "value 必须为字符串" }, 400);
  await systemConfig.setConfig(name, body.value);
  return c.json({
    data: SECRET_CONFIG_NAMES.has(name)
      ? { name, value: "", secret_configured: body.value.length > 0 }
      : { name, value: body.value },
  });
});

/* ------------------------------------------------------------------ *
 * license — /api/admin/license* → key: license
 * ------------------------------------------------------------------ */
adminRoutes.get("/license", async (c) => {
  const license = await licenseService.getLicense();
  return c.json({ data: license ?? { type: "none" } });
});

/* ------------------------------------------------------------------ *
 * 权限元数据 —— 给前端渲染菜单/角色编辑器
 * 挂 /api/admin/meta/*；未在 ADMIN_ROUTE_TABLE 登记 → 非超管 403（fail-closed 合理）
 * ------------------------------------------------------------------ */
adminRoutes.get("/meta/resources", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const access = getEffectiveAccess(user);
  return c.json({
    data: {
      resources: ADMIN_RESOURCES.map((r) => ({
        ...r,
        granted: user?.super_admin ? "write" : (access.get(r.key) ?? null),
      })),
    },
  });
});

/* ------------------------------------------------------------------ *
 * 角色管理（$super）—— 仅超管。路径 /api/admin/role 命中 SUPER_ADMIN_KEY
 * ------------------------------------------------------------------ */
adminRoutes.get("/role", async (c) => {
  const rows = await db.adminRole.findMany({
    orderBy: { id: "desc" },
    include: { _count: { select: { users: true } } },
  });
  return c.json({ data: rows });
});

adminRoutes.post("/role", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name) return c.json({ error: "名称不能为空" }, 400);
  const exist = await db.adminRole.findUnique({ where: { name } });
  if (exist) return c.json({ error: "角色名称已存在" }, 409);

  const role = await db.adminRole.create({
    data: {
      name,
      description: body?.description ?? null,
      permissions: sanitizePermissions(body?.permissions),
    },
  });
  return c.json({ data: role }, 201);
});

adminRoutes.put("/role/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const role = await db.adminRole.findUnique({ where: { id } });
  if (!role) return c.json({ error: "角色不存在" }, 404);

  const name = String(body?.name ?? role.name).trim();
  const duplicate = await db.adminRole.findFirst({ where: { name, NOT: { id } } });
  if (duplicate) return c.json({ error: "角色名称已存在" }, 409);

  const updated = await db.adminRole.update({
    where: { id },
    data: {
      name,
      description: body?.description ?? role.description,
      permissions: sanitizePermissions(body?.permissions ?? role.permissions),
    },
  });
  return c.json({ data: updated });
});

adminRoutes.delete("/role/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const count = await db.user.count({ where: { admin_roles: { some: { id } } } });
  if (count > 0) return c.json({ error: `该角色仍被 ${count} 个用户使用，请先解除分配` }, 409);
  await db.adminRole.delete({ where: { id } });
  return c.json({ data: { ok: true } });
});

/** 给用户分配角色（仅超管） */
adminRoutes.put("/user/:id/roles", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const roleIds: number[] = Array.isArray(body?.admin_role_ids) ? body.admin_role_ids : [];

  const target = await db.user.findUnique({ where: { id } });
  if (!target) return c.json({ error: "用户不存在" }, 404);

  const updated = await db.user.update({
    where: { id },
    data: { admin_roles: { set: roleIds.map((rid) => ({ id: Number(rid) })) } },
    include: { admin_roles: true },
  });
  return c.json({ data: { id: updated.id, admin_roles: updated.admin_roles } });
});
