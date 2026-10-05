/**
 * Agent machine endpoints mounted under `/api/internal`.
 *
 * These routes bypass user-session authentication but never bypass machine
 * identity: enrollment uses a short-lived one-time token; steady-state control
 * uses the per-node Bearer credential. CSRF is not applicable because Agents do
 * not use browser session cookies.
 *
 * Production control is Agent-initiated HTTP(S):
 * - POST /api/internal/node/state
 * - GET  /api/internal/node/snapshot
 * - GET  /api/internal/node/commands
 * - POST /api/internal/node/ack
 *
 * The Panel never needs to dial an Agent management port. Authorization headers,
 * request credentials and credential fragments must never be logged.
 */
import { Hono } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { authenticateNode } from "../services/node-credential.ts";
import {
  buildReconnectSnapshot,
  extractBearerCredential,
  renewOwnedLeases,
  submitStateReport,
} from "../services/node-state.ts";
import {
  consumeNodeEnrollment,
  extractEnrollmentToken,
  renderNodeInstallScript,
} from "../services/node-enrollment.ts";
import {
  buildDesiredNodeSnapshot,
  dequeueAgentCommand,
  storeAgentCommandAck,
  type AgentCommandAck,
} from "../services/agent-command-bus.ts";

export const internalNodeRoutes = new Hono<{ Variables: AppVariables }>();

/**
 * GET /api/internal/node/install.sh
 *
 * Public installer code contains no credential. The short-lived enrollment
 * token is passed as a shell argument by the Panel-generated one-liner.
 */
internalNodeRoutes.get("/node/install.sh", (c) => {
  return c.body(renderNodeInstallScript(), 200, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "no-store",
  });
});

/**
 * POST /api/internal/node/enroll
 *
 * Authorization: Enrollment <short-lived-token>
 *
 * This is the only bridge from installer token to long-lived node credential.
 * The token is consumed atomically and cannot be replayed.
 */
internalNodeRoutes.post("/node/enroll", async (c) => {
  const token = extractEnrollmentToken(c.req.header("authorization"));
  if (!token) return c.json({ ok: false, error: "invalid_enrollment" }, 401);
  try {
    const enrolled = await consumeNodeEnrollment(token, c.get("ip") || null);
    if ((c.req.header("accept") ?? "").includes("text/plain")) {
      return c.body(enrolled.credential, 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    return c.json({
      data: {
        credential: enrolled.credential,
        node_id: enrolled.node_id,
        node_key: enrolled.node_key,
        agent_id: enrolled.agent_id,
      },
    });
  } catch {
    return c.json({ ok: false, error: "invalid_enrollment" }, 401);
  }
});

/** 认证包装：HTTP 层只需要「401/503 三态 + node_id」，避免每个处理器重复展开判别联合。 */
async function authedNode(
  authorization: string | undefined,
): Promise<{ ok: true; node_id: number; scope: number } | { ok: false; status: 401 | 503; reason: string }> {
  const credential = extractBearerCredential(authorization ?? null);
  if (!credential) return { ok: false, status: 401, reason: "missing_credential" };
  const auth = await authenticateNode(credential);
  if (!auth.ok) {
    // blocked / invalid / revoked 都回 401（不区分，避免拿响应当重试信号）；
    // db_unavailable 回 503，Agent 该退避重试而不是换凭据。
    return { ok: false, status: auth.reason === "db_unavailable" ? 503 : 401, reason: auth.reason };
  }
  return { ok: true, node_id: auth.node_id, scope: auth.scope };
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
    data: {
      ok: true,
      node_id: result.node_id,
      reported_at: result.reported_at.toISOString(),
      // : the agent learns here how long it may keep serving. Absent/empty means
      // "the panel has no ownership information for you", which is also the honest answer
      // for a node that owns nothing.
      leases: result.leases,
    },
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


/**
 * GET /api/internal/node/commands
 *
 * One-at-a-time outbound command pull. Empty queue is a normal 200 response;
 * Agent polls again. Command ownership is implicit in the credential-derived
 * node id and workspace scope, so callers cannot request another node's queue.
 */
internalNodeRoutes.get("/node/commands", async (c) => {
  const auth = await authedNode(c.req.header("authorization"));
  if (!auth.ok) return c.json({ ok: false, error: auth.reason }, auth.status);
  const command = await dequeueAgentCommand(auth.scope, auth.node_id);
  return c.json({ data: { command } });
});

/** POST /api/internal/node/ack —— Agent executes a queued command then ACKs it. */
internalNodeRoutes.post("/node/ack", async (c) => {
  const auth = await authedNode(c.req.header("authorization"));
  if (!auth.ok) return c.json({ ok: false, error: auth.reason }, auth.status);
  const body = await c.req.json().catch(() => null) as AgentCommandAck | null;
  if (!body || typeof body !== "object" || typeof body.command_id !== "string" || typeof body.ok !== "boolean") {
    return c.json({ ok: false, error: "invalid_ack" }, 400);
  }
  try {
    await storeAgentCommandAck(auth.scope, auth.node_id, {
      command_id: body.command_id,
      ok: body.ok,
      applied_revision: typeof body.applied_revision === "number" ? body.applied_revision : null,
      error_code: typeof body.error_code === "string" ? body.error_code : null,
      error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
      // : a read-only action may return structured findings. They are
      // validated and bounded in the bus, not trusted as-is.
      ...(body.results !== undefined ? { results: body.results as never } : {}),
      ...(body.facts !== undefined ? { facts: body.facts as never } : {}),
      // V5.1b : a datagram RELAY's own hop endpoint rides its apply ACK
      // (`ip:port`; see CommandAckPayload.hop_local_addr for why it cannot wait for
      // the periodic state report).
      //
      // This route is the HTTP boundary where an ACK is REBUILT FIELD BY FIELD, so a
      // field not listed here is dropped before anything else on the panel can see it:
      // the agent set it (`type=*forwarder.DatagramRelay diag_ok=true hop=172.41.20.10:56588`),
      // the ledger and the orchestrator were both ready to carry it, and the correction
      // still never fired — the fact died right here. Same closed-key-set shape as
      // `ACTION_PAYLOAD_KEYS.command_ack` and `runtime_counts`; it is worth assuming every
      // boundary in this path has one.
      ...(typeof body.hop_local_addr === "string" && body.hop_local_addr.trim() !== ""
        ? { hop_local_addr: body.hop_local_addr }
        : {}),
    });
  } catch {
    return c.json({ ok: false, error: "invalid_ack" }, 400);
  }
  return c.json({ data: { ok: true } });
});

/**
 * GET /api/internal/node/desired
 *
 * Startup restore source: canonical desired state for this concrete Node.
 * It never re-schedules from NodeGroup; only Tunnel.ingress_node_id /
 * egress_node_id bindings are returned.
 */
internalNodeRoutes.get("/node/desired", async (c) => {
  const auth = await authedNode(c.req.header("authorization"));
  if (!auth.ok) return c.json({ ok: false, error: auth.reason }, auth.status);

  //  —— startup restore 也是一次“现任 owner 还活着”的强证明。
  //
  // Agent reinstall / 长时间离线后，旧 ownership lease 可能已经过期。若先构建
  // desired snapshot，再等随后的 /node/state 才续约，快照会把**过期 deadline**
  // 发给刚启动的 Agent；ownership guard 会正确地拒绝/停掉 runtime。后续 heartbeat
  // 虽然把 DB lease 续上，却不会凭空重建已经没起来的 listener，表现为“控制面 online，
  // 数据面不恢复”（V4-F2.37）。
  //
  // 这里只续约**本节点已经持有**的 lease；renewOwnedLeases 不会抢别人的 owner，
  // 因而不会绕过两阶段 fencing。存储失败仍 fail-soft：快照带旧 deadline，
  // Agent fail-closed，牺牲可用性但不制造双主。
  await renewOwnedLeases(auth.node_id, new Date());

  const snapshot = await buildDesiredNodeSnapshot(auth.node_id);
  return c.json({ data: { snapshot } });
});
