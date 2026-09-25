/**
 * WP7 — Node state report（上报落库） + reconnect snapshot（重连恢复）
 *
 * 依据 `DEVELOPMENT.md` §7.10「WP7 — Node Credential / Session / State Report」。
 *
 * ── 上报的形状（Agent → 面板，Agent 主动出站 POST）──
 *   `POST /api/internal/node/state`  `Authorization: Bearer <node credential>`
 *   {
 *     "version": "0.13.22", "role": "BOTH",
 *     "tunnels":    [ { "id", "mode", "ingress_port", "egress_port", "revision", "targets"? } ],
 *     "used_ports": [ 8443, 30001 ],
 *     "egress_pools": { "<tunnelId>": { "strategy": "round", "targets": ["10.0.0.2:80"] } },
 *     "reported_revision": 17, "last_error": null
 *   }
 * 身份**不来自载荷**：node 由 Bearer 凭据解析（services/node-credential.ts），
 * 载荷里的 role 只作展示对齐，不一致以 `node.role` 为准（面板管理员显式设置的
 * 才是真相，§7.4「role 不回填、不猜」的延伸）。
 *
 * ── 为什么每节点一行（upsert）而不是追加时序 ──
 *   · reconnect snapshot 的语义是「这个节点当前是什么状态」，时序表要再查最近
 *     一条才能得到同一结论，且历史行会无限膨胀（节点每分钟心跳一次）；
 *   · WP9 reconciler 对比 desired / applied 需要 O(1) 取到「Agent 自述事实」；
 *   · 离线判定用 `reported_at` + Redis 心跳键（§7.10 的状态查询不替代
 *     offline-detector 的防抖），本表只回答「最近一次报的是什么」。
 *
 * ── 与 WP6 控制协议的关系 ──
 * 上报是**回报类**（非 mutating）：它不推进任何 revision，只更新事实快照。
 * `reported_revision` 是否落后于 `tunnel.config_revision` 由调用方判定
 * （WP9 reconciler：落后 = 该重发，不是该拒绝）。
 *
 * ── 日志纪律 ──
 * 本模块不写 console。载荷里没有凭据，路由层也不得把 Authorization 头回显
 * 到任何日志/响应（见 routes/node-state.ts 的批注）。
 */
import { db } from "../db.ts";
import { authenticateNode, hashNodeCredential } from "./node-credential.ts";

/* ================================================================== */
/* 形状（与 agent/internal/api 的 NodeState 字段对齐）                  */
/* ================================================================== */

/** Agent 上报的单个出口目标（对齐 forwarder.Target 的 JSON 形态）。 */
export interface ReportedTarget {
  /** Agent 侧字段名是 `host`（forwarder.Target），面板侧别处用 `address`：
   *  上报载荷**以 Agent 为准**收 `host`，同时容忍 `address`（历史载荷）。 */
  host?: string;
  address?: string;
  port?: number;
  weight?: number;
  order?: number;
}

/** Agent 上报的单条隧道状态（对齐 forwarder.TunnelConfig 的 JSON 形态）。 */
export interface ReportedTunnel {
  id: string;
  mode?: string;
  ingress_port?: number;
  egress_port?: number;
  revision?: number;
  /** Agent 其余自报字段（remote_host/lb_strategy/…）原样透传。 */
  remote_host?: string;
  remote_port?: number;
  lb_strategy?: string;
  protocol?: string;
  speed_limit?: number;
  listen_host?: string;
  targets?: ReportedTarget[];
}

/** Agent 上报的出口池快照（对齐 agent reporter.EgressPool）。 */
export interface ReportedEgressPool {
  strategy: string;
  targets: string[];
}

/** 上报载荷。未定义未知字段不做猜测式解析——原样存 JSON，坏形状由校验函数拦。 */
export interface StateReportInput {
  agent_id?: string;
  version?: string;
  role?: string;
  tunnels?: ReportedTunnel[];
  used_ports?: number[];
  egress_pools?: Record<string, ReportedEgressPool>;
  reported_revision?: number;
  last_error?: string | null;
}

/** 落库后的快照（供 reconnect / 查询用）。 */
export interface StateSnapshot {
  node_id: number;
  version: string | null;
  role: string | null;
  reported_revision: number | null;
  tunnels: unknown;
  egress_pools: unknown;
  used_ports: unknown;
  last_error: string | null;
  reported_at: Date;
}

/* ================================================================== */
/* 纯校验（无 IO，可离线单测）                                          */
/* ================================================================== */

export type StateReportRejection =
  | "missing_credential"
  | "invalid_json"
  | "bad_agent_id"
  | "bad_version"
  | "bad_role"
  | "bad_tunnels"
  | "bad_used_ports"
  | "bad_egress_pools"
  | "bad_revision"
  | "bad_last_error";

/**
 * 载荷校验（fail-closed）：任何坏形状返回原因码，调用方回 400。
 *
 * 刻意宽松的地方：`role` 接受任意非空字符串（Agent 自报，面板以 node.role 为准）；
 * `tunnels[i]` 只要求 `id` 非空字符串，其余字段缺失即视为「该隧道还没来得及
 * 报全」而不是整体拒绝——Agent 的部分状态比没有状态有用。
 */
export function validateStateReport(body: unknown): { ok: true; report: StateReportInput } | { ok: false; reason: StateReportRejection } {
  // 数组也是 object，但状态载荷必须是「带名字段的对象」——`[1,2]` / `[]`
  // 一律坏形状（Agent 不会把状态报成一个列表）。
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "invalid_json" };
  const b = body as Record<string, unknown>;

  if (b.agent_id !== undefined && (typeof b.agent_id !== "string" || b.agent_id.length === 0 || b.agent_id.length > 64)) {
    return { ok: false, reason: "bad_agent_id" };
  }
  if (b.version !== undefined && typeof b.version !== "string") return { ok: false, reason: "bad_version" };
  if (b.role !== undefined && typeof b.role !== "string") return { ok: false, reason: "bad_role" };
  if (b.reported_revision !== undefined && typeof b.reported_revision !== "number") {
    return { ok: false, reason: "bad_revision" };
  }
  if (b.last_error !== undefined && b.last_error !== null && typeof b.last_error !== "string") {
    return { ok: false, reason: "bad_last_error" };
  }

  if (b.tunnels !== undefined) {
    if (!Array.isArray(b.tunnels)) return { ok: false, reason: "bad_tunnels" };
    for (const t of b.tunnels) {
      if (!t || typeof t !== "object") return { ok: false, reason: "bad_tunnels" };
      const tt = t as Record<string, unknown>;
      if (typeof tt.id !== "string" || tt.id.length === 0) return { ok: false, reason: "bad_tunnels" };
      // 端口字段：缺失 = Agent 还没报全（容忍），类型错 = 坏形状（拒绝）。
      for (const key of ["ingress_port", "egress_port", "revision"]) {
        const v = tt[key];
        if (v !== undefined && typeof v !== "number") return { ok: false, reason: "bad_tunnels" };
      }
      // targets：Agent 报的可能是旧形状（address）或新形状（host）。只要求
      // 「数组里的每项是对象、port 是数字」，其余字段缺失不拦——面板侧
      // reconciler（WP9）自己决定能不能用这个 target，上报层不做语义判断。
      if (tt.targets !== undefined) {
        if (!Array.isArray(tt.targets)) return { ok: false, reason: "bad_tunnels" };
        for (const tgt of tt.targets) {
          if (!tgt || typeof tgt !== "object") return { ok: false, reason: "bad_tunnels" };
          const t = tgt as Record<string, unknown>;
          if (t.port !== undefined && typeof t.port !== "number") {
            return { ok: false, reason: "bad_tunnels" };
          }
        }
      }
    }
  }

  if (b.used_ports !== undefined) {
    if (!Array.isArray(b.used_ports)) return { ok: false, reason: "bad_used_ports" };
    if (!b.used_ports.every((p) => typeof p === "number")) return { ok: false, reason: "bad_used_ports" };
  }

  if (b.egress_pools !== undefined) {
    if (!b.egress_pools || typeof b.egress_pools !== "object" || Array.isArray(b.egress_pools)) {
      return { ok: false, reason: "bad_egress_pools" };
    }
    for (const pool of Object.values(b.egress_pools as Record<string, unknown>)) {
      if (!pool || typeof pool !== "object") return { ok: false, reason: "bad_egress_pools" };
      const p = pool as Record<string, unknown>;
      if (typeof p.strategy !== "string") return { ok: false, reason: "bad_egress_pools" };
      if (!Array.isArray(p.targets)) return { ok: false, reason: "bad_egress_pools" };
    }
  }

  return {
    ok: true,
    report: {
      agent_id: b.agent_id as string | undefined,
      version: b.version as string | undefined,
      role: b.role as string | undefined,
      tunnels: b.tunnels as ReportedTunnel[] | undefined,
      used_ports: b.used_ports as number[] | undefined,
      egress_pools: b.egress_pools as Record<string, ReportedEgressPool> | undefined,
      reported_revision: b.reported_revision as number | undefined,
      last_error: b.last_error as string | null | undefined,
    },
  };
}

/** 从 Authorization 头取 Bearer 明文（不解析合法性，只做形态抽取）。 */
export function extractBearerCredential(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/* ================================================================== */
/* 上报（身份由凭据定，不由载荷定）                                       */
/* ================================================================== */

export type SubmitResult =
  | { ok: true; node_id: number; scope: number; reported_at: Date }
  | { ok: false; status: 401 | 400 | 503; reason: string };

/**
 * 认证 + 落库一次上报。
 *
 * 顺序不可换：先 {@link authenticateNode}（凭据即身份），再校验载荷，最后 upsert。
 * 反过来会让未认证的载荷先过校验、把错误信息当探针。DB 不可用回 503 而不是
 * 回 400/200——Agent 需要区分「我形状错了」和「面板暂时坏了，待会儿重试」。
 */
export async function submitStateReport(
  authorization: string | undefined | null,
  body: unknown,
): Promise<SubmitResult> {
  const credential = extractBearerCredential(authorization);
  if (!credential) return { ok: false, status: 401, reason: "missing_credential" };

  const auth = await authenticateNode(credential);
  if (!auth.ok) {
    // blocked / invalid / revoked 都回 401（不区分，避免拿响应当重试信号）；
    // db_unavailable 回 503，Agent 该退避重试而不是换凭据。
    return { ok: false, status: auth.reason === "db_unavailable" ? 503 : 401, reason: auth.reason };
  }

  const validated = validateStateReport(body);
  if (!validated.ok) return { ok: false, status: 400, reason: validated.reason };

  const report = validated.report;
  // Credential remains the authentication truth. agent_id is an immutable
  // runtime-instance guard: new Agents report it and must match the Node row.
  // Older Agents that do not report agent_id remain temporarily compatible.
  if (report.agent_id !== undefined && report.agent_id !== auth.agent_id) {
    return { ok: false, status: 401, reason: "agent_id_mismatch" };
  }
  const reportedAt = new Date();
  await db.nodeStateReport.upsert({
    where: { node_id: auth.node_id },
    create: {
      node_id: auth.node_id,
      version: report.version ?? null,
      role: report.role ?? null,
      reported_revision: report.reported_revision ?? null,
      // 空数组也照原样写：Agent 「现在一个隧道都没有」是有意义的事实，
      // 与「还没报过」不同（后者在 DB 里表现为没有这一行）。
      tunnels: (report.tunnels ?? []) as never,
      egress_pools: (report.egress_pools ?? {}) as never,
      used_ports: (report.used_ports ?? []) as never,
      last_error: report.last_error ?? null,
      reported_at: reportedAt,
    },
    update: {
      version: report.version ?? null,
      role: report.role ?? null,
      reported_revision: report.reported_revision ?? null,
      tunnels: (report.tunnels ?? []) as never,
      egress_pools: (report.egress_pools ?? {}) as never,
      used_ports: (report.used_ports ?? []) as never,
      last_error: report.last_error ?? null,
      reported_at: reportedAt,
    },
  });

  // 顺带刷新 node.last_seen_at：面板展示与离线判定都读它（WP1 列，WP7 首次写入）。
  await db.node
    .updateMany({ where: { id: auth.node_id }, data: { last_seen_at: reportedAt } })
    .catch(() => {
      /* 心跳刷新失败不影响上报结论 */
    });

  return { ok: true, node_id: auth.node_id, scope: auth.scope, reported_at: reportedAt };
}

/* ================================================================== */
/* reconnect snapshot（断线重连后的状态恢复）                            */
/* ================================================================== */

/**
 * 取节点最近一次上报的快照。**null = 从未上报过**（新节点 / 刚签发凭据）。
 *
 * 这是 reconnect snapshot 的读取面：Agent 断开又连上时，面板用它回答
 * 「这个节点上次的状态是什么」，与 restore（Agent 侧拉 ACTIVE 隧道）互补：
 *   · restore 给 Agent **该运行的**（desired）；
 *   · 本函数给面板**它曾运行的**（reported）。
 * 两者的差就是 WP9 reconciler 的输入。
 */
export async function loadNodeSnapshot(nodeDbId: number): Promise<StateSnapshot | null> {
  const row = await db.nodeStateReport.findUnique({
    where: { node_id: nodeDbId },
    select: {
      node_id: true,
      version: true,
      role: true,
      reported_revision: true,
      tunnels: true,
      egress_pools: true,
      used_ports: true,
      last_error: true,
      reported_at: true,
    },
  });
  if (!row) return null;
  return row as StateSnapshot;
}

/**
 * 给 Agent 的重连快照（REST 形态，`GET /api/internal/node/snapshot`）。
 *
 * 只回**Agent 自己那一份**（nodeDbId 由凭据解析，不接受路径参数指定别的节点）——
 * 否则 A 的凭据就能读 B 的快照。字段保持在 Agent 侧可消费的最小集：
 * 版本、角色、revision、隧道、端口、池。不回 reported_at 之类面板内部字段。
 */
export async function buildReconnectSnapshot(nodeDbId: number): Promise<Record<string, unknown> | null> {
  const snap = await loadNodeSnapshot(nodeDbId);
  if (!snap) return null;
  return {
    version: snap.version,
    role: snap.role,
    reported_revision: snap.reported_revision,
    tunnels: snap.tunnels ?? [],
    used_ports: snap.used_ports ?? [],
    egress_pools: snap.egress_pools ?? {},
  };
}

/**
 * 指纹：上报内容的稳定摘要（用于「这次上报和上次有区别吗」的低成本比较）。
 * 不存明文凭据，也不存任何密钥——输入只有快照字段。
 */
export function snapshotFingerprint(snapshot: StateSnapshot | null): string {
  if (!snapshot) return "";
  return hashNodeCredential(
    JSON.stringify({
      v: snapshot.version,
      r: snapshot.role,
      rev: snapshot.reported_revision,
      t: snapshot.tunnels ?? null,
      p: snapshot.used_ports ?? null,
      e: snapshot.egress_pools ?? null,
    }),
  );
}
