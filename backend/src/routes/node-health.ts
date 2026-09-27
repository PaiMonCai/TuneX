/**
 * V4-WP6 — Node health API（管理端：单节点健康 + 全量巡检）
 *
 * 依据 `DEVELOPMENT.md` §13.4.4。挂载（app.ts）：`/api/admin`，与
 * node-admin.ts / node-lifecycle.ts 同批，认证与权限由挂载点统一施加
 * （adminRequired → adminPermissionGuard），本文件不重复挂。
 *
 * ── 端点总览 ──
 *   GET /api/admin/node/:id/health   单节点：三层状态 + health 判定 + 遥测视图
 *   GET /api/admin/node/health       全量巡检（?health=/?lifecycle=）+ 计数摘要
 *
 * ── RBAC 归属（不新增资源键，复用 `nodes`）──
 * 两个路径都在 `/admin/node` 前缀下，与 WP5/WP10 的节点端点同一资源
 * （permissions.ts 的 `nodes`）。health 是节点管理面的读能力，不是独立业务域：
 * 新增资源键会让同一个「看节点」的动作散落到两个授权项上。
 *
 * ── 为什么把 health 放在独立文件而不是塞进 node-admin.ts ──
 * node-admin.ts 是 WP10 的池/目标/凭据 CRUD（有写路径、有 §2.2 池不变式），
 * health 是纯读的派生视图。混进去会让「池不变式」与「健康阈值」两套规则在
 * 同一个文件里演化，也让 WP6 的测试不得不替身一整张池/目标表。本文件只读
 * node / node_state_report / tunnel 三张表。
 *
 * ── 凭据纪律 ──
 * 响应只由 `NodeHealthView` 组成：没有 `node_credential_hash`，也没有明文
 * （health 判定只需要「有没有凭据」这一个布尔）。
 *
 * ── 限流 ──
 * 两条都是 GET（巡检页会轮询），走 `api-global`（600/min，user 维度）；
 * 不新建专属规则——读端点不会因额度小而被误伤，也不需要更严的写保护。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.ts";
import { getNodeHealth, listNodeHealth } from "../services/node-health-service.ts";
import { resolveNodeId } from "../services/node-admin.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeHealthRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/** 节点 id 解析失败（数字主键或 node_id 字符串都找不到）→ 404。 */
async function nodeNotFound(c: Ctx, message: string) {
  return c.json({ error: message, message }, 404);
}

/* ------------------------------------------------------------------ *
 * GET /api/admin/node/health —— 全量巡检（注册在 :id 变体之前）
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/node/health
 *
 * `?health=healthy|warning|error|unknown`（缺省/`all` = 不过滤）
 * `?lifecycle=active|maintenance|disabled|retiring`（同上）
 *
 * 响应同时给 `items` 与 `summary`（四态计数）。**summary 是过滤前的全量
 * 计数**：巡检页要能回答「有多少个节点是 error」而不必先拉全部节点，而
 * `items` 只给用户当前筛选想看的那一页口径。
 *
 * 注册顺序提醒：本路径必须**在** `/node/:id/health` 之前注册，否则
 * `:id` 会把字面量 `health` 当成节点标识（Hono 按注册顺序首个匹配生效）。
 */
nodeHealthRoutes.get("/node/health", async (c) => {
  const result = await listNodeHealth({
    health: c.req.query("health"),
    lifecycle: c.req.query("lifecycle"),
  });
  if (!result.ok) {
    return c.json({ error: result.message, message: result.message, code: result.code }, 400);
  }
  return c.json({ data: result.items, total: result.total, summary: result.summary });
});

/* ------------------------------------------------------------------ *
 * GET /api/admin/node/:id/health
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/node/:id/health
 *
 * 单节点视图：`health`（healthy/warning/error/unknown）、`connection`
 * （waiting/online/offline）、`reasons`（带严重度与用户可读文案的判定理由）、
 * `flags`、`telemetry`（版本 / 资源 / runtime / 端口 / 错误账本）。
 *
 * 未上报的节点回 200 + `telemetry = null`（不是 404）：新节点还没有事实是
 * 正常状态，前端据此显示「等待首次上报」，而 health 会是 `unknown`。
 */
nodeHealthRoutes.get("/node/:id/health", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeHealth(resolved.id);
  if (!result.ok) return nodeNotFound(c, result.message);
  return c.json({ data: result.view });
});
