/**
 * WP7 — 节点状态上报 / 重连快照 HTTP 端点（免认证，Bearer 节点凭据）
 *
 * 挂在 `/api/internal` 下（app.ts 中 `app.route("/api", publicRoutes)` 之前挂载），
 * 与既有 `/api/tunnel/observer`、`/api/tunnel/traffic` 同一类「机器端点」：
 *   · **免用户认证**：调用方是 Agent，没有用户会话（auth.ts 的 NO_AUTH_PATTERNS
 *     里有 `^\/api\/internal\/.*` 的显式豁免，见该处批注）；
 *   · **不免身份校验**：身份 = Bearer 节点凭据（services/node-credential.ts），
 *     解析出的 node_id 即归属，载荷里的任何 node 标识一律忽略；
 *   · **CSRF 豁免**：非浏览器客户端，不携带会话 cookie（middlewares/csrf.ts 的
 *     CSRF_EXEMPT_PATTERNS 与本文件路径一一对应，两边同步加）；
 *   · **专属限流规则**：按 IP 维度（节点没有 userId），规则必须排在 api-global
 *     之前，否则全部节点按 anon 共用一桶互相误伤（WP1 防爆破键同源的教训）。
 *
 * 端点：
 *   POST /api/internal/node/state     —— 上报状态快照（upsert 每节点一行）
 *   GET  /api/internal/node/snapshot  —— 重连快照（断线重连后恢复自己那份状态）
 *
 * 「NAT Agent 只靠出站连接工作」在这里落地为：两个端点都由 Agent 主动发起
 * （POST 上报 / GET 拉取），面板从不主动连 Agent；面板给 Agent 的下发仍走
 * Socket.IO（Agent 出站建连）——与 §7.9「控制 transport 由 Agent 主动出站」
 * 完全一致。
 *
 * ⚠️ 日志纪律：本文件**不**把 Authorization 头、请求体或任何凭据片段写进
 * console；响应体也永不含凭据。凭据明文只存在于 rotate 的响应（管理端点）。
 */
import { Hono } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { authenticateNode } from "../services/node-credential.ts";
import {
  buildReconnectSnapshot,
  extractBearerCredential,
  submitStateReport,
} from "../services/node-state.ts";

export const internalNodeRoutes = new Hono<{ Variables: AppVariables }>();

/** 认证包装：HTTP 层只需要「401/503 三态 + node_id」，避免每个处理器重复展开判别联合。 */
async function authedNode(
  authorization: string | undefined,
): Promise<{ ok: true; node_id: number } | { ok: false; status: 401 | 503; reason: string }> {
  const credential = extractBearerCredential(authorization ?? null);
  if (!credential) return { ok: false, status: 401, reason: "missing_credential" };
  const auth = await authenticateNode(credential);
  if (!auth.ok) {
    // blocked / invalid / revoked 都回 401（不区分，避免拿响应当重试信号）；
    // db_unavailable 回 503，Agent 该退避重试而不是换凭据。
    return { ok: false, status: auth.reason === "db_unavailable" ? 503 : 401, reason: auth.reason };
  }
  return { ok: true, node_id: auth.node_id };
}

/**
 * POST /api/internal/node/state —— 状态上报
 *
 * 响应语义（Agent 按它决定下一步）：
 *   · 200 上报已接受（DB 已更新）；
 *   · 400 形状错误（reason 指向坏字段，Agent 无需重试同一载荷）；
 *   · 401 凭据无效/已撤销/被封禁（Agent 应停止重试并告警，不该换载荷）；
 *   · 503 面板侧不可用（Agent 退避重试，不是它的错）。
 *
 * 刻意不像 observer/traffic 那样「失败也回 200」：那两个端点数据无归属即
 * 丢弃、重试也不会变对；本端点的 401/503 对 Agent 是**有意义**的信号
 * （凭据被撤销 = 必须人工介入），吞成 200 会让撤销后 Agent 空转。
 */
internalNodeRoutes.post("/node/state", async (c) => {
  const authorization = c.req.header("authorization");
  const body = await c.req.json().catch(() => null);
  const result = await submitStateReport(authorization, body);
  if (!result.ok) {
    return c.json({ ok: false, error: result.reason }, result.status);
  }
  return c.json({
    data: { ok: true, node_id: result.node_id, reported_at: result.reported_at.toISOString() },
  });
});

/**
 * GET /api/internal/node/snapshot —— 重连快照
 *
 * 身份同样只由 Bearer 凭据定：**不接受查询参数指定别的节点**，否则 A 的凭据
 * 就能读 B 的快照。从未上报过 → 200 + `{ data: { snapshot: null } }`（不是
 * 404：新节点没有快照是正常状态，Agent 会接着走 restore 拉 desired）。
 */
internalNodeRoutes.get("/node/snapshot", async (c) => {
  const auth = await authedNode(c.req.header("authorization"));
  if (!auth.ok) return c.json({ ok: false, error: auth.reason }, auth.status);
  const snapshot = await buildReconnectSnapshot(auth.node_id);
  return c.json({ data: { snapshot } });
});
