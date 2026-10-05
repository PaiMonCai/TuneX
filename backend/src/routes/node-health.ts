/**
 * Read-only Admin Node health surface.
 *
 * Health is derived from node lifecycle, connection/runtime facts and telemetry.
 * These routes share the existing `nodes` resource permission and intentionally
 * remain separate from the mutable egress/credential control surface.
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
