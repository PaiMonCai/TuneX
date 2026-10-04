/**
 * V4 Forward product service.
 *
 * Product boundary:
 *   Forward = user-facing business object
 *   Tunnel  = internal desired/runtime state
 *
 * Both the new /api/forwards routes and the deprecated
 * /api/nodes/:ingressId/forwards compatibility routes call this service so
 * creation, validation and runtime actions have one implementation.
 */
import { Prisma } from "@prisma/client";
import type { TunnelType } from "@prisma/client";
import { db } from "../db.ts";
import {
  countWorkspaceTunnels,
  sumWorkspaceTraffic,
  withWorkspaceQuotaLock,
} from "./policy-service.ts";
import { checkTunnelCreation } from "./capability-policy.ts";
import { getOrchestrator } from "./relay-wiring.ts";
import { reapplyDirectTunnel, reapplyRelayTunnel } from "./scheduler.ts";
import { registerRollout } from "./forward-rollout-exec.ts";
// V5.5 WP15：远端出口腿的声明校验与释放。声明校验只有这一个实现（路由层也复用它），
// 所以"能保存但跑不起来"不可能出现两次不同的结论。
import {
  releaseStaleFederatedEgressForTunnel,
  validateFederatedEgressDeclaration,
} from "./federation/forward-hop.ts";
import {
  FORWARD_REVISION_ERROR_CODES,
  ForwardRevisionError,
  computeForwardImpact,
  createForwardRevision,
  currentDesiredConfig,
  ensureForwardBaselineRevision,
  isMetadataOnlyPatch,
  mergeForwardCandidate,
  normalizeFederatedEgressPeer,
  validateForwardCandidate,
  validateForwardCandidateFull,
  type ForwardCandidateConfig,
  type ForwardCandidateContext,
  type ForwardCandidatePatch,
  type ForwardDesiredStatus,
  type ForwardPreviewResult,
  type ForwardRevisionErrorCode,
  type ForwardRevisionRow,
  type ForwardValidation,
} from "./forward-revision.ts";
import {
  runTunnelAction as runTunnelActionApi,
  TUNNEL_API_ERROR_STATUS,
  type TunnelAction,
} from "./tunnel-api.ts";
import { nodeAdmission } from "./node-lifecycle.ts";
import { FORWARD_LIST_MAX_UNPAGED } from "./forward-list-query.ts";
import { checkForwardRuntimeUse } from "./forward-capability.ts";
import { authorizationErrorLayer, type AuthorizationErrorLayer } from "./authorization-errors.ts";
import type { ForwardPage } from "./forward-list-query.ts";
import {
  normalizeForwardProtocol,
  persistedForwardProtocol,
  type ForwardMode,
  type ForwardProtocol,
  tlsPathsForProtocol,
  legacyTunnelTypeColumn,
} from "./forward-contract.ts";
export type { ForwardMode, ForwardProtocol } from "./forward-contract.ts";
import {
  forwardBatchSummary,
  type ForwardBatchAction,
  type ForwardBatchItemResult,
  type ForwardBatchSummary,
} from "./forward-batch.ts";

export type ForwardApplyStatus = "pending" | "applying" | "active" | "error" | "suspended";
export type ForwardAction = Extract<TunnelAction, "retry" | "suspend" | "resume">;
export interface ForwardCreateInput {
  name: string;
  mode: ForwardMode;
  /** V5-WP0: omitted by V4 clients => tcp; explicit unknown values fail closed. */
  protocol?: ForwardProtocol;
  /**
   * V5-WP5-A1: node-local certificate/key paths for a tls front. Paths, never
   * key material (§6.1). Ignored for every other protocol — the panel does not
   * silently turn a stray path into a TLS front.
   */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
  ingress_node_id: number;
  egress_node_id?: number | null;
  /**
   * V5.4：三跳路由的中间跳（省略 = 单跳）。给了它就意味着入口 → 中间 → 出口，
   * 且相邻两段都必须已有 NodeBinding（校验在创建/更新路径上统一做）。
   */
  middle_node_id?: number | null;
  listen_port?: number | null;
  target_host: string;
  target_port: number;
  /**
   * V5.5 WP15：把这条 Forward 的**出口腿**委托给某个已信任的 peer panel
   * （存 peer_panel_id；`undefined`/`null` = 出口在本机，即今天的行为）。
   *
   * 声明了它就**不能**再给 `egress_node_id`：出口腿只能在一侧（见
   * `validateForwardCandidate` 的互斥判定）。
   */
  federated_egress_peer?: string | null;
}

export interface ForwardListInput {
  ingress_node_id?: number;
  egress_node_id?: number;
  mode?: ForwardMode;
  apply_status?: ForwardApplyStatus;
  keyword?: string;
}

export interface ForwardPatchInput {
  name?: string;
  /** V4-WP1 §13.3.1：创建后可编辑的全部业务字段。 */
  mode?: ForwardMode;
  ingress_node_id?: number;
  egress_node_id?: number | null;
  /** V5.4：中间跳（`null` = 回到单跳）。与入出口同类：改它会触发新 revision 与 rollout。 */
  middle_node_id?: number | null;
  listen_port?: number | null;
  target_host?: string | null;
  target_port?: number | null;
  /**
   * V5-WP5-A1：tls 前端的证书/私钥路径可改，规则与创建时完全相同（只有 tls 能带，
   * 且必须成对）—— 由 `tlsPathsForProtocol` 统一判定，不在这里复制一份规则。
   *
   * 协议本身仍然不可改：`protocol` 不在 patch 白名单里。把一个 tcp 转发改成 tls
   * 是"换一个东西"，不是"编辑"（端口租约、目标语义、RELAY 形态都要重新决定），
   * §6.1 没有冻结这个语义，因此不猜。
   */
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
  /**
   * V5.5 WP15：出口腿的承载方（`null` = 改回本机出口）。与 `egress_node_id` 互斥。
   */
  federated_egress_peer?: string | null;
  /** V4-WP1 §13.3.3：乐观并发；不匹配 → 409 revision_conflict。 */
  expected_revision?: number | null;
}

export type ForwardServiceError = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 502 | 503;
  code: string;
  message: string;
  apply_error_code?: string;
  error_layer?: AuthorizationErrorLayer;
  data?: unknown;
};

/**
 * 读回 tunnel 行；读不到时（极端情况：并发删除）退回最小投影，让调用方至少
 * 能拿到 revision。blocked 分支用——那时「已保存」本身就是成功语义，
 * 不能因为读行失败把一次成功的保存报错。
 */
async function reloadOrMinimal(
  id: number,
  workspaceId: number,
  revision: number,
): Promise<Parameters<typeof forwardView>[0]> {
  const row = await loadForwardRow(id, workspaceId);
  return row ?? ({ id, config_revision: revision, apply_status: "pending" } as never);
}

/**
 * V4-WP5 §13.4.2：节点准入判定的**唯一**转发出口。
 *
 * 创建 Forward / 迁移到新节点前必须过这里。判定逻辑一行都不在本文件——
 * lifecycle 与 connection 的口径全在 `services/node-lifecycle.ts` 的
 * `nodeAdmission`（WP1/WP3/WP8 共用），两边各自判一遍必然漂移。
 *
 * 返回 null = 放行；否则是 { code, message } 形状的阻断（`data` 里可选附带
 * 具体 condition，供 §13.5 的可区分错误码）。
 */
function nodeAdmissionError(node: {
  lifecycle?: string | null;
  status?: string | null;
  last_seen_at?: Date | null;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}): { code: "conflict"; message: string; data: { condition: string } } | null {
  const admission = nodeAdmission({
    lifecycle: node.lifecycle ?? null,
    status: node.status ?? null,
    last_seen_at: node.last_seen_at ?? null,
    has_credential: Boolean(node.node_credential_hash),
    credential_revoked: Boolean(node.credential_revoked),
  });
  if (admission.ok) return null;
  return { code: "conflict", message: admission.message, data: { condition: admission.condition } };
}

export type ForwardServiceResult<T> =
  | { ok: true; data: T }
  | ForwardServiceError;

const nodeSelect = {
  id: true,
  node_id: true,
  agent_id: true,
  connect_ip: true,
  role: true,
  node_group_id: true,
  lb_strategy: true,
  // V4-WP1：自动分配端口前必须确认节点配置了区间（§7.6「未配置区间拒绝分配」）。
  port_range_min: true,
  port_range_max: true,
  // V4-WP5：§13.4.2 准入判定需要 lifecycle（desired 管理态）。它和下面 role
  // 的能力判定是两个正交维度：role=ingress 的节点也可能正处于 maintenance。
  lifecycle: true,
  // §13.4.1 Connection 层事实：准入谓词要求「已安装且未撤销」。
  status: true,
  last_seen_at: true,
  node_credential_hash: true,
  credential_revoked: true,
  node_group: { select: { workspace_id: true } },
} as const;

const forwardInclude = Prisma.validator<Prisma.TunnelInclude>()({
  ingress_node: {
    select: {
      id: true,
      node_id: true,
      agent_id: true,
      connect_ip: true,
      role: true,
    },
  },
  egress_node: {
    select: {
      id: true,
      node_id: true,
      agent_id: true,
      connect_ip: true,
      role: true,
    },
  },
  egress_pool: {
    include: {
      targets: {
        where: { status: "active" as const },
        orderBy: [{ order_by: "asc" as const }, { id: "asc" as const }],
      },
    },
  },
});

function error(
  status: ForwardServiceError["status"],
  code: string,
  message: string,
  extra?: Pick<ForwardServiceError, "apply_error_code" | "data" | "error_layer">,
): ForwardServiceError {
  return { ok: false, status, code, message, error_layer: authorizationErrorLayer(code, extra?.data), ...extra };
}

function targetAddress(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[")
    ? `[${host}]:${port}`
    : `${host}:${port}`;
}

export function forwardView(t: any) {
  const target =
    t.tunnel_mode === "relay"
      ? t.egress_pool?.targets?.[0] ?? null
      : t.remote_host && t.remote_port
        ? { host: t.remote_host, port: t.remote_port, weight: 1 }
        : null;

  const protocol = persistedForwardProtocol(t.forward_protocol, t.tunnel_type);
  return {
    id: t.id,
    creator_user_id: t.user_id ?? null,
    name: t.name,
    protocol,
    protocol_supported: normalizeForwardProtocol(protocol) !== null,
    // V5-WP5-A1: the paths are part of a tls Forward's configuration, so the view
    // carries them. Without them the detail page can say "TLS" but never which
    // certificate, and an operator cannot verify a path without reading the DB —
    // the projection is the API, and an unexposed fact is an unavailable one.
    // Paths only: key material never leaves the node.
    tls_cert_path: protocol === "tls" ? (t.tls_cert_path ?? null) : null,
    tls_key_path: protocol === "tls" ? (t.tls_key_path ?? null) : null,
    mode: (t.tunnel_mode ?? "direct") as ForwardMode,
    ingress_node_id: t.ingress_node_id,
    ingress_node: t.ingress_node ?? null,
    egress_node_id: t.egress_node_id,
    egress_node: t.egress_node ?? null,
    listen_ip: t.listen_ip,
    listen_port: t.listen_port,
    target_host: target?.host ?? null,
    target_port: target?.port ?? null,
    target_weight: target?.weight ?? null,
    traffic: Number(t.traffic ?? 0),
    traffic_cost: Number(t.traffic_cost ?? 0),
    online: t.apply_status === "active",
    desired_status: t.desired_status,
    apply_status: t.apply_status,
    config_revision: t.config_revision,
    applied_revision: t.applied_revision,
    // V4-WP1：desired revision 指针 + 最新 revision 号。前端保存时把它们作为
    // expected_revision 回传（§13.3.3 乐观并发）。
    desired_revision_id: t.desired_revision_id ?? null,
    latest_revision: t.config_revision ?? 0,
    apply_error_code: t.apply_error_code,
    apply_error: t.apply_error,
    last_applied_at: t.last_applied_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

async function loadWorkspaceNode(nodeId: number, workspaceId: number) {
  return db.node.findFirst({
    where: { id: nodeId, node_group: { workspace_id: workspaceId } },
    select: nodeSelect,
  });
}

async function loadForwardRow(id: number, workspaceId: number) {
  return db.tunnel.findFirst({
    where: {
      id,
      workspace_id: workspaceId,
      category: "port_forward",
    },
    include: forwardInclude,
  });
}

interface RelayRevisionResources {
  poolId: number | null;
  egressPort: number | null;
  targets: Array<{ host: string; port: number; weight: number; order_by: number }> | null;
}

/**
 * Prepare the desired RELAY pool without touching the currently applied Agent
 * runtime. The old runtime owns an immutable in-memory/snapshot config until
 * CUTOVER, so moving this Forward's dedicated pool is safe and compensatable.
 */
async function prepareRelayRevisionResources(
  tx: Prisma.TransactionClient,
  tunnelId: number,
  current: any,
  candidate: ForwardCandidateConfig,
  ctx: ResolvedCandidate["ctx"],
): Promise<RelayRevisionResources> {
  if (candidate.mode !== "relay") {
    return { poolId: null, egressPort: null, targets: null };
  }
  // V5.5 WP15：远端出口腿没有本机 EgressPool —— 池表达的是"某台**本机**出口节点
  // 拨号去哪里"，而那一跳不在这台面板上（契约 §1/§7：不复制远端资源）。
  // 目标仍要作为本版 revision 的运行态事实落到 snapshot（rollout 的 apply 会把它
  // 交给 host），所以这里直接返回目标集合并跳过本地池的增删。
  const federatedPeer = normalizeFederatedEgressPeer(candidate.federated_egress_peer);
  if (federatedPeer !== null) {
    const host = candidate.target_host ?? ctx.egressTargets?.[0]?.host ?? null;
    const port = candidate.target_port ?? ctx.egressTargets?.[0]?.port ?? null;
    if (host == null || port == null) {
      throw new ForwardRevisionError("invalid_input", "远端出口腿必须至少有一个目标（host + port）");
    }
    return {
      poolId: null,
      egressPort: null,
      targets: [{ host, port, weight: 1, order_by: 1000 }],
    };
  }
  if (!ctx.egress || candidate.egress_node_id == null) {
    throw new ForwardRevisionError("node_unavailable", "RELAY 转发缺少出口节点");
  }

  const targetHost = candidate.target_host ?? ctx.egressTargets?.[0]?.host ?? null;
  const targetPort = candidate.target_port ?? ctx.egressTargets?.[0]?.port ?? null;
  if (!targetHost || targetPort == null) {
    throw new ForwardRevisionError("invalid_input", "RELAY 转发必须至少有一个有效目标");
  }

  const poolName = `forward-${tunnelId}`;
  const onDesiredNode = await tx.egressPool.findUnique({
    where: {
      node_id_name: {
        node_id: candidate.egress_node_id,
        name: poolName,
      },
    },
    select: { id: true },
  });

  let poolId: number;
  if (onDesiredNode) {
    poolId = onDesiredNode.id;
    await tx.egressPool.update({
      where: { id: poolId },
      data: {
        status: "active",
        lb_strategy: (ctx.egress.lb_strategy as any) ?? "round",
      },
    });
  } else if (current.egress_pool?.name === poolName) {
    const moved = await tx.egressPool.update({
      where: { id: current.egress_pool.id },
      data: {
        node_id: candidate.egress_node_id,
        status: "active",
        lb_strategy: (ctx.egress.lb_strategy as any) ?? "round",
      },
      select: { id: true },
    });
    poolId = moved.id;
  } else {
    const created = await tx.egressPool.create({
      data: {
        node_id: candidate.egress_node_id,
        name: poolName,
        lb_strategy: (ctx.egress.lb_strategy as any) ?? "round",
        status: "active",
      },
      select: { id: true },
    });
    poolId = created.id;
  }

  await tx.egressTarget.deleteMany({ where: { pool_id: poolId } });
  await tx.egressTarget.create({
    data: {
      pool_id: poolId,
      host: targetHost,
      port: targetPort,
      weight: 1,
      order_by: 1000,
      status: "active",
    },
  });

  const placementChanged =
    current.tunnel_mode !== "relay" ||
    Number(current.egress_node_id ?? 0) !== candidate.egress_node_id;
  return {
    poolId,
    egressPort: placementChanged ? null : current.egress_port ?? null,
    targets: [{ host: targetHost, port: targetPort, weight: 1, order_by: 1000 }],
  };
}

/**
 * V4-WP9 §13.6：列表 where 的唯一构造点。
 *
 * `listForwards`（兼容裸数组）与 `listForwardsPage`（产品分页端点）共用它，
 * 否则「筛选口径」会出现两份实现——那是 §13.3.3 明确要消灭的漂移形态。
 */
function forwardListWhere(
  workspaceId: number,
  input: ForwardListInput,
): Prisma.TunnelWhereInput {
  const where: Prisma.TunnelWhereInput = {
    workspace_id: workspaceId,
    category: "port_forward",
    ...(input.ingress_node_id
      ? { ingress_node_id: input.ingress_node_id }
      : {}),
    ...(input.egress_node_id
      ? { egress_node_id: input.egress_node_id }
      : {}),
    ...(input.mode ? { tunnel_mode: input.mode } : {}),
    ...(input.apply_status ? { apply_status: input.apply_status } : {}),
  };

  const keyword = input.keyword?.trim();
  if (keyword) {
    const matches: Prisma.TunnelWhereInput[] = [
      { name: { contains: keyword } },
      { remote_host: { contains: keyword } },
      { ingress_node: { node_id: { contains: keyword } } },
      { egress_node: { node_id: { contains: keyword } } },
    ];
    // 端口也可以直接搜：用户在列表里看到 `:20001` 就会试着粘进来。
    // 纯数字关键字才加数值条件——否则 `contains` 语义的字符串条件与分析
    // 目标端口（remote_port）的关系会让「搜 abc」意外匹配端口为 0 的行。
    const port = Number(keyword);
    if (Number.isInteger(port) && port > 0) {
      matches.push({ listen_port: port });
      matches.push({ remote_port: port });
    }
    where.OR = matches;
  }
  return where;
}

/**
 * 「取全部」语义：**上限在服务层**，不在路由层。
 *
 * 放在服务层是因为有三个调用方（V4 产品端点的不分页分支、兼容端点
 * `/api/nodes/:ingressId/forwards`、其它内部消费方），上限写在路由里就会漏。
 * 一旦需要超过 500 条的完整遍历，应使用 `listForwardsPage` 逐页取，而不是
 * 把这里的数字调大——无界 `findMany` 是规模化的对立场。
 */
export async function listForwards(workspaceId: number, input: ForwardListInput = {}) {
  const rows = await db.tunnel.findMany({
    where: forwardListWhere(workspaceId, input),
    orderBy: [{ order_by: "asc" }, { id: "desc" }],
    take: FORWARD_LIST_MAX_UNPAGED,
    include: forwardInclude,
  });
  return rows.map(forwardView);
}

/**
 * V4-WP9 §13.6：服务端分页 / 排序的 Forward 列表。
 *
 * `orderBy` 由 `forward-list-query.ts` 的白名单派生（含 `id desc` 稳定兜底），
 * 因此路由层不拼列名、前端 mock 与真实后端共用同一套键表。
 */
export async function listForwardsPage(
  workspaceId: number,
  input: ForwardListInput = {},
  page: { skip: number; take: number; orderBy: Array<Record<string, "asc" | "desc">> },
): Promise<ForwardPage<ReturnType<typeof forwardView>>> {
  const where = forwardListWhere(workspaceId, input);
  const [rows, total] = await Promise.all([
    db.tunnel.findMany({
      where,
      orderBy: page.orderBy as Prisma.TunnelOrderByWithRelationInput[],
      skip: page.skip,
      take: page.take,
      include: forwardInclude,
    }),
    db.tunnel.count({ where }),
  ]);
  return { data: rows.map(forwardView), total } as ForwardPage<
    ReturnType<typeof forwardView>
  >;
}

export interface ForwardSummary {
  total: number;
  direct: number;
  relay: number;
  active: number;
  error: number;
  suspended: number;
  pending: number;
  traffic: number;
  traffic_cost: number;
}

export async function getForwardSummary(
  workspaceId: number,
): Promise<ForwardSummary> {
  const base: Prisma.TunnelWhereInput = {
    workspace_id: workspaceId,
    category: "port_forward",
  };
  const [total, direct, relay, active, errorCount, suspended, pending, usage] =
    await Promise.all([
      db.tunnel.count({ where: base }),
      db.tunnel.count({ where: { ...base, tunnel_mode: "direct" } }),
      db.tunnel.count({ where: { ...base, tunnel_mode: "relay" } }),
      db.tunnel.count({ where: { ...base, apply_status: "active" } }),
      db.tunnel.count({ where: { ...base, apply_status: "error" } }),
      db.tunnel.count({ where: { ...base, apply_status: "suspended" } }),
      db.tunnel.count({
        where: { ...base, apply_status: { in: ["pending", "applying"] } },
      }),
      db.tunnel.aggregate({
        where: base,
        _sum: { traffic: true, traffic_cost: true },
      }),
    ]);

  return {
    total,
    direct,
    relay,
    active,
    error: errorCount,
    suspended,
    pending,
    traffic: Number(usage._sum.traffic ?? 0),
    traffic_cost: Number(usage._sum.traffic_cost ?? 0),
  };
}

export async function getForward(
  id: number,
  workspaceId: number,
): Promise<ReturnType<typeof forwardView> | null> {
  const row = await loadForwardRow(id, workspaceId);
  return row ? forwardView(row) : null;
}

export async function getForwardTraffic(
  id: number,
  workspaceId: number,
  days = 14,
): Promise<
  ForwardServiceResult<
    { date: string; traffic: number; traffic_cost: number }[]
  >
> {
  const current = await db.tunnel.findFirst({
    where: {
      id,
      workspace_id: workspaceId,
      category: "port_forward",
    },
    select: { id: true },
  });
  if (!current) return error(404, "not_found", "端口转发不存在");

  const windowDays = Math.max(1, Math.min(90, Math.floor(days) || 14));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (windowDays - 1));

  const rows = await db.tunnelTraffic.findMany({
    where: { tunnel_id: current.id, date: { gte: since } },
    orderBy: { date: "asc" },
  });

  const byDate = new Map<string, { traffic: number; traffic_cost: number }>();
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10);
    const acc = byDate.get(key) ?? { traffic: 0, traffic_cost: 0 };
    acc.traffic += row.traffic;
    acc.traffic_cost += row.traffic_cost;
    byDate.set(key, acc);
  }

  const points: { date: string; traffic: number; traffic_cost: number }[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    const hit = byDate.get(key);
    points.push({
      date: key,
      traffic: hit ? Number(hit.traffic.toFixed(2)) : 0,
      traffic_cost: hit ? Number(hit.traffic_cost.toFixed(4)) : 0,
    });
  }

  return { ok: true, data: points };
}

export async function createForward(
  userId: number,
  workspaceId: number,
  input: ForwardCreateInput,
): Promise<ForwardServiceResult<ReturnType<typeof forwardView>>> {
  const protocol = normalizeForwardProtocol(input.protocol);
  if (protocol === null) {
    return error(400, "invalid_input", "当前版本不支持该转发协议");
  }
  // V5-WP5-A1: a tls front needs both paths, and only a tls front accepts them.
  // The panel cannot check that the files exist (they live on the node); what it
  // must not do is dispatch "serve TLS" without a certificate, or quietly attach
  // paths to a protocol that has no TLS front.
  const tlsPaths = tlsPathsForProtocol(protocol, input.tls_cert_path, input.tls_key_path);
  if (!tlsPaths.ok) return error(400, "invalid_input", tlsPaths.reason);
  if (
    !input.name.trim() ||
    !input.target_host.trim() ||
    !Number.isInteger(input.ingress_node_id) ||
    input.ingress_node_id < 1 ||
    !Number.isInteger(input.target_port) ||
    input.target_port < 1 ||
    input.target_port > 65535 ||
    (input.listen_port != null &&
      (!Number.isInteger(input.listen_port) ||
        input.listen_port < 1 ||
        input.listen_port > 65535))
  ) {
    return error(400, "invalid_input", "端口转发参数不合法");
  }

  const egressId = input.egress_node_id ?? null;
  // V5.5 WP15：出口腿"在哪一侧"是这次创建的一部分。声明了 peer 时本机没有出口
  // 节点，这不是"缺出口"，而是"出口在另一侧"（互斥判定在 validateForwardCandidate）。
  const federatedPeer = normalizeFederatedEgressPeer(input.federated_egress_peer);
  if (federatedPeer !== null && input.mode !== "relay") {
    return error(400, "invalid_input", "只有 RELAY 转发才有独立的出口跳，DIRECT 不能声明远端出口");
  }
  if (federatedPeer !== null) {
    // 声明必须**当场**成立（存在 + trusted + 联邦已开启）：否则会出现一条"保存成功、
    // 每次都失败在远端"的 Forward，而用户只看到一次 201。失败给契约 §6 的错误码，
    // 不压成 500 —— 用户/管理员据此知道下一步是去 Admin Console 建信任。
    const declared = await validateFederatedEgressDeclaration(federatedPeer);
    if (!declared.ok) {
      return error(409, declared.code, `远端出口腿不可用：${declared.message}`);
    }
  }
  if (input.mode === "direct" && egressId !== null) {
    return error(400, "invalid_input", "DIRECT 转发不能指定出口节点");
  }
  if (input.mode === "relay" && egressId === null && federatedPeer === null) {
    return error(400, "invalid_input", "RELAY 转发必须指定出口节点");
  }
  // 互斥：两处同时声明出口时，运行期没人知道该信哪个（本地会去分端口、远端也会去
  // 租一条腿，而它们代表同一跳）。
  if (federatedPeer !== null && egressId !== null) {
    return error(400, "invalid_input", "远端出口 peer 与本机出口节点互斥：出口腿只能在一侧");
  }

  const ingress = await loadWorkspaceNode(input.ingress_node_id, workspaceId);
  if (!ingress) return error(404, "not_found", "入口节点不存在");
  if (ingress.role !== "ingress" && ingress.role !== "both") {
    return error(409, "conflict", "该节点不具备入口能力");
  }
  // §13.4.2：active 才接受新业务。role 判定回答「有没有能力」，这里回答
  // 「现在允不允许接」——二者正交，一个 ingress 节点可以正处于 maintenance。
  const ingressAdmission = nodeAdmissionError(ingress);
  if (ingressAdmission) {
    return error(409, ingressAdmission.code, ingressAdmission.message, {
      data: ingressAdmission.data,
    });
  }

  const egress =
    egressId === null ? null : await loadWorkspaceNode(egressId, workspaceId);
  if (egressId !== null && !egress) {
    return error(404, "not_found", "出口节点不存在");
  }
  if (egress && egress.id === ingress.id) {
    return error(409, "conflict", "入口和出口不能是同一节点");
  }
  if (egress && egress.role !== "egress" && egress.role !== "both") {
    return error(409, "conflict", "选择的节点不具备出口能力");
  }
  if (egress) {
    // §13.4.2：出口节点同样必须过准入（maintenance/disabled/retiring/waiting
    // 都不接受新业务）。不能只判入口——RELAY 的两端都是新 runtime 的落点。
    const egressAdmission = nodeAdmissionError(egress);
    if (egressAdmission) {
      return error(409, egressAdmission.code, egressAdmission.message, {
        data: egressAdmission.data,
      });
    }
  }

  if (egress) {
    // V5.4：三跳路由的两段邻接是 (入口→中间) 与 (中间→出口)，而 (入口→出口) 那条
    // **不被使用** —— 只查后者会让三跳路由在没有许可的情况下被创建出来，然后在下发时才炸。
    const middleId = input.middle_node_id ?? null;
    if (middleId != null) {
      const pairs = await db.nodeBinding.findMany({
        where: {
          OR: [
            { ingress_node_id: ingress.id, egress_node_id: middleId },
            { ingress_node_id: middleId, egress_node_id: egress.id },
          ],
        },
        select: { ingress_node_id: true, egress_node_id: true },
      });
      const ok1 = pairs.some((b) => b.ingress_node_id === ingress.id && b.egress_node_id === middleId);
      const ok2 = pairs.some((b) => b.ingress_node_id === middleId && b.egress_node_id === egress.id);
      if (!ok1 || !ok2) {
        return error(409, "binding_required", "三跳路由要求入口→中间、中间→出口两段都已绑定");
      }
    } else {
      const binding = await db.nodeBinding.findUnique({
        where: {
          ingress_node_id_egress_node_id: {
            ingress_node_id: ingress.id,
            egress_node_id: egress.id,
          },
        },
        select: { id: true },
      });
      if (!binding) {
        return error(409, "binding_required", "该出口尚未绑定到当前入口节点");
      }
    }
  }

  const target = targetAddress(input.target_host.trim(), input.target_port);

  const reserved = await withWorkspaceQuotaLock(
    workspaceId,
    async (tx, policy) => {
      const [tunnelCount, trafficUsed, maxOrder] = await Promise.all([
        countWorkspaceTunnels(workspaceId, tx),
        sumWorkspaceTraffic(
          workspaceId,
          policy.limits.traffic_period,
          new Date(),
          tx,
        ),
        tx.tunnel.aggregate({ _max: { order_by: true } }),
      ]);

      const decision = checkTunnelCreation(policy, {
        tunnelCount,
        trafficUsed,
        protocol,
        inGroupOwned: true,
        inGroupId: ingress.node_group_id,
        outGroupId: egress?.node_group_id ?? null,
        outGroupOwned: true,
      });
      if (!decision.allowed) return { denied: decision } as const;

      if (input.listen_port != null) {
        const conflict = await tx.tunnel.findFirst({
          where: {
            ingress_node_id: ingress.id,
            listen_port: input.listen_port,
          },
          select: { id: true },
        });
        if (conflict) return { conflict: true } as const;
      }

      const tunnel = await tx.tunnel.create({
        data: {
          name: input.name.trim(),
          // The legacy column is a compatibility projection only, and for a
          // protocol the legacy enum cannot express it stays absent (the column
          // default applies) instead of being filled with a name that means
          // something else — see legacyTunnelTypeForForwardProtocol.
          // The contract is the source of the legacy names ('tcp' / 'tls'), and
          // Prisma's generated enum type cannot see it — this cast is the
          // boundary between the two. It is `TunnelType`, not `string`: a value
          // the enum does not know must be a compile error, which is exactly the
          // bug this line was written to fix (`ws` has no legacy enum value).
          ...(legacyTunnelTypeColumn(protocol) as { tunnel_type?: TunnelType }),
          forward_protocol: protocol,
          ...tlsPaths.columns,
          category: "port_forward",
          listen_ip: "0.0.0.0",
          listen_port: input.listen_port ?? null,
          listen_protocol: [protocol],
          status: "active",
          forward_addresses: input.mode === "direct" ? [target] : [],
          forward_addresses_protocol:
            input.mode === "direct" ? [protocol] : [],
          load_balance_type: "round",
          ip_type: "ipv4",
          order_by: (maxOrder._max.order_by ?? 0) + 10,
          in_node_group_id: ingress.node_group_id,
          out_node_group_id: egress?.node_group_id ?? null,
          user_id: userId,
          workspace_id: workspaceId,
          tunnel_mode: input.mode,
          ingress_node_id: ingress.id,
          egress_node_id: egress?.id ?? null,
          // V5.5 WP15：声明列与 Forward 行同时落库（同一事务）。远端那一跳的节点/
          // 端口不在这里、也不在任何本地资源表里 —— 它只以 federation_placement 的
          // 不透明引用存在（契约 §1/§7）。
          ...(federatedPeer === null ? {} : { federated_egress_peer: federatedPeer }),
          // V5.4：三跳路由的中间跳（省略 = 单跳）。创建路径直接用 `input`（候选尚未构建）。
          middle_node_id: input.middle_node_id ?? null,
          desired_status: "inactive",
          apply_status: "pending",
          config_revision: 0,
          applied_revision: null,
          remote_host:
            input.mode === "direct" || federatedPeer !== null
              ? input.target_host.trim()
              : null,
          remote_port:
            input.mode === "direct" || federatedPeer !== null
              ? input.target_port
              : null,
        },
        select: { id: true },
      });

      let poolId: number | null = null;
      if (egress) {
        const pool = await tx.egressPool.create({
          data: {
            node_id: egress.id,
            name: `forward-${tunnel.id}`,
            lb_strategy: egress.lb_strategy ?? "round",
            status: "active",
            targets: {
              create: {
                host: input.target_host.trim(),
                port: input.target_port,
                weight: 1,
                order_by: 1000,
                status: "active",
              },
            },
          },
          select: { id: true },
        });
        poolId = pool.id;
        await tx.tunnel.update({
          where: { id: tunnel.id },
          data: { egress_pool_id: poolId },
        });
      }

      return { tunnelId: tunnel.id, poolId } as const;
    },
  );

  const denied = "denied" in reserved ? reserved.denied : null;
  if (denied) {
    return error(
      403,
      denied.reason ?? "policy_denied",
      denied.message ?? "策略拒绝",
    );
  }
  if ("conflict" in reserved) {
    return error(409, "port_conflict", "该入口端口已被占用");
  }

  const tunnelId =
    "tunnelId" in reserved && typeof reserved.tunnelId === "number"
      ? reserved.tunnelId
      : null;
  if (tunnelId === null) {
    return error(503, "db_unavailable", "创建端口转发失败");
  }

  const orchestrator = getOrchestrator();
  if (orchestrator) {
    const applied =
      input.mode === "direct"
        ? await reapplyDirectTunnel(tunnelId, orchestrator)
        : await reapplyRelayTunnel(tunnelId, orchestrator);

    if (!applied.ok) {
      // V5.4：把**失败在哪一步**打出来。
      //
      // 创建失败此前只回一个 502 body，`steps` / `failedStep` 被整条丢掉，于是"出口之后到底哪一步
      // 失败"只能靠猜 —— 而这一步的失败会**留下已发出的出口 runtime**（实测 `tunex-277-egress`
      // 占着 22001），每次尝试都在毒化下一次。没有这行日志，那类泄漏看起来像"端口分配有 bug"。
      const failedStep = (applied as { failedStep?: string }).failedStep ?? "unknown";
      const trail = (applied as { steps?: Array<{ step: string; ok: boolean; error_code?: string | null }> }).steps ?? [];
      console.error(
        "[forward] create failed:",
        JSON.stringify({
          tunnel_id: tunnelId,
          failed_step: failedStep,
          error_code: applied.error_code,
          trail: trail.map((s2) => `${s2.step}${s2.ok ? "" : `(${s2.error_code ?? "fail"})`}`),
        }),
      );
      const failed = await loadForwardRow(tunnelId, workspaceId);
      return error(502, "apply_failed", applied.error, {
        apply_error_code: applied.error_code,
        data: failed ? forwardView(failed) : { id: tunnelId },
      });
    }
    await ensureForwardBaselineRevision(tunnelId, userId).catch(() => null);
  }

  const created = await loadForwardRow(tunnelId, workspaceId);
  if (!created) {
    return error(503, "db_unavailable", "端口转发创建后无法读取");
  }
  return { ok: true, data: forwardView(created) };
}

export async function patchForward(
  id: number,
  workspaceId: number,
  patch: ForwardPatchInput,
  actorId?: number,
): Promise<ForwardServiceResult<ReturnType<typeof forwardView>>> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return error(404, "not_found", "端口转发不存在");

  // ── V4-WP1 §13.3.3：校验逻辑只有一个实现 ──
  // patchForward 与 previewForwardUpdate 都走 resolveForwardCandidate() → 同一个
  // 合并 + 同一个校验 + 同一个影响面计算；两者只差「是否落库」。
  const resolved = await resolveForwardCandidate(id, workspaceId, patch, actorId);
  if (!resolved.ok) return resolved.error;

  const { base, candidate, ctx, metadataOnly, desiredStatus } = resolved.data;

  // V5.5 WP15：声明"出口腿放到 peer X"必须当场成立（存在 + trusted + 联邦已开启），
  // 否则会保存出一条每次都失败在远端的 Forward。只在声明**非空**时查库：
  // 未声明（绝大多数路径）一次查询都不多，行为逐字节不变。
  const candidatePeer = normalizeFederatedEgressPeer(candidate.federated_egress_peer);
  if (candidatePeer !== null) {
    const declared = await validateFederatedEgressDeclaration(candidatePeer);
    if (!declared.ok) {
      return error(409, declared.code, `远端出口腿不可用：${declared.message}`);
    }
  }

  if (metadataOnly) {
    // §13.3.2：纯 metadata（name）修改不生成 revision、不 bump config_revision、
    // 不触发任何 runtime 收敛。
    await db.tunnel.update({
      where: { id: current.id },
      data: { name: candidate.name.trim() },
    });
    const renamed = await loadForwardRow(id, workspaceId);
    if (!renamed) return error(404, "not_found", "端口转发不存在");
    return { ok: true, data: forwardView(renamed) };
  }

  // expected_revision 闸门：在落库前比对，过期直接 409（§13.3.3）。
  if (patch.expected_revision !== undefined && patch.expected_revision !== null) {
    const latest = Number(current.config_revision ?? 0);
    if (Number(patch.expected_revision) !== latest) {
      return error(409, "revision_conflict", "该转发已被他人修改，请刷新后重新确认", {
        data: { latest_revision: latest },
      });
    }
  }

  // 存量/创建路径自愈：已经有真实 applied runtime 但还没有 snapshot 指针时，
  // 先冻结当前 applied revision，保证首次 listener replacement 有旧 runtime。
  if (current.applied_revision != null && current.desired_revision_id == null) {
    try {
      await ensureForwardBaselineRevision(current.id, ctx.userId);
    } catch {
      return error(503, "db_unavailable", "保存前无法建立已应用版本基线，请稍后重试");
    }
  }

  // Pool/snapshot/topology projection are one desired-config transaction.
  // New egress placement stores egress_port=NULL; PREPARE allocates the
  // concrete per-node port and markTunnelApplied persists it after ACK.
  let revision: number;
  try {
    const result = await db.$transaction(async (tx) => {
      const resources = await prepareRelayRevisionResources(
        tx,
        current.id,
        current,
        candidate,
        ctx,
      );
      const written = await createForwardRevision(
        {
          tunnelId: current.id,
          candidate,
          desiredStatus,
          createdById: ctx.userId,
          egressTargets: resources.targets,
          resolvedListenIp: ctx.ingress?.connect_ip
            ? String(ctx.ingress.connect_ip).split(",").map((x) => x.trim()).find(Boolean) ?? null
            : null,
          egressPort: resources.egressPort,
          egressPoolId: resources.poolId,
        },
        tx,
      );
      await tx.tunnel.update({
        where: { id: current.id },
        data: {
          in_node_group_id: ctx.ingress?.node_group_id ?? current.in_node_group_id,
          out_node_group_id:
            candidate.mode === "relay"
              ? (ctx.egress?.node_group_id ?? current.out_node_group_id)
              : null,
          egress_pool_id: resources.poolId,
          egress_port: resources.egressPort,
          // V5.5 WP15：声明列与 snapshot 在同一事务落库（与 `createForwardRevision`
          // 内写 snapshot 的那一列取值完全相同，来源都是候选）。
          ...(candidate.federated_egress_peer === undefined
            ? {}
            : { federated_egress_peer: normalizeFederatedEgressPeer(candidate.federated_egress_peer) }),
          // V5.4：中间跳与入出口同类 —— patch 里给了就落库，没给就沿用候选里的当前值
          // （候选由 `mergeForwardCandidate` 合并，因此"没提交"永远是"不变"）。
          middle_node_id: candidate.middle_node_id ?? null,
          // V5-WP5-A1: the tls paths are part of the desired configuration, so a
          // patch that changes them must persist them — and a patch that leaves
          // them out must not silently drop them (the candidate carries the
          // current values forward). This is the same rule the protocol follows,
          // and the reason an operator can now rotate to a new certificate FILE
          // NAME without deleting the Forward (which would also reassign an
          // auto-allocated listen port).
          ...tlsPathsForCandidate(candidate),
        },
      });
      return { written, resources };
    });
    revision = result.written.revision;
    ctx.egressTargets = result.resources.targets;
  } catch (e) {
    if (e instanceof ForwardRevisionError) {
      return error(
        e.status as ForwardServiceError["status"],
        e.code,
        e.message,
        { data: e.data },
      );
    }
    return error(503, "db_unavailable", "保存失败，请稍后重试");
  }

  // Missing Binding is deliberately left to rollout PREPARE/ensure_binding.
  // Pre-creating it here would erase the preview/plan impact and split semantics.

  // ── WP3 §13.3.2/§13.3.4：影响面 = rollout 计划的唯一输入 ──
  // 与 previewForwardUpdate（下面同一 resolveForwardCandidate 的形状）逐字同一
  // 组入参，§13.3.3「preview 与 update 同源」：planRollout 不重算差异。
  const resolvedListenPort = candidate.listen_port ?? current.listen_port ?? null;
  const impact = computeForwardImpact({
    current: base,
    candidate,
    ingressNodeId: ctx.ingress?.node_id ?? null,
    egressNodeId: ctx.egress?.node_id ?? null,
    currentIngressNodeId: current.ingress_node?.node_id ?? null,
    currentEgressNodeId: current.egress_node?.node_id ?? null,
    ingressConnectIp: ctx.ingress?.connect_ip ?? null,
    resolvedListenPort,
    currentResolvedListenPort: current.listen_port ?? null,
    bindingRequired: candidate.mode === "relay" && ctx.bindingExists === false,
  });

  // ── WP3 接入点：落库后走五阶段 rollout，替换 WP1 的"同步 reapply"出口 ──
  //
  // 为什么替换而不是并存（报告 §5 C6 + §1.1「WP1 的收敛出口必须替换」）：
  // 旧的 `reapplyDirectTunnel/reapplyRelayTunnel` 是**创建路径**的编排器——
  // 它自己 bind_nodes、自己 allocateTunnelPort、自己 config_revision = 读回 + 1、
  // 失败时 desired_status=inactive，语义上是"重推一遍创建"，不是"按预先生成的
  // revision 滚动"。两条路径并存会让"改端口"有时走五阶段有时走创建路径，
  // 而后者会重新选节点/端口——正是 §13.3.5 要消灭的那类分叉。
  //
  // 契约不变的部分（WP1 冻结，WP4 依赖）：
  //   · 成功仍返回 200 + forwardView；
  //   · 失败仍返回 502 `apply_failed` + `apply_error_code` + 当前行快照；
  //   · `applied_revision` 不动、revision 历史不删（§4.1 铁律）。
  const suspended = current.apply_status === "suspended";
  const orchestrator = getOrchestrator();
  const runtime = orchestrator
    ? await registerRollout(
        {
          tunnelId: current.id,
          impact,
          revision,
          baseRevision: current.applied_revision ?? null,
          // §13.3.6：suspended 编辑 = 存 desired 不启 runtime（noop rollout）。
          suspended,
        },
        { db: db as never, orchestrator: orchestrator as never },
      ).catch(() => null)
    : null;

  // orchestrator 未接线（relay-wiring 失败）⇒ 跳过本轮执行，不回错误。
  // 保存本身已成功（snapshot + revision 已落库，§4.1 铁律不破），worker 下一轮
  // `resumeRollouts()` 会补上——与 WP1「orchestrator 缺失就跳过 reapply」同口径。
  // 注意：此分支**不会**创建 rollout 行，因此不需要回 502/409。
  if (runtime && runtime.status === "conflict") {
    // 同期已有未完成 rollout（§13.3.5 抢占闸门）⇒ 409，前端刷新后重试。
    // 必须先于通用 !ok 判断，否则 conflict 会被错误折叠成 502 apply_failed。
    return error(409, "revision_conflict", "该转发已有正在进行的更新", {
      data: { latest_revision: revision },
    });
  }
  if (runtime && runtime.status === "blocked") {
    // ── V4-WP5 §13.4.2 + §13.3.5 失败规则一 ──
    // rollout 的 VALIDATE 拒绝（节点此刻 maintenance / retiring / disabled /
    // 未安装）。**desired 与 revision 已可靠落库**，只是不启 runtime——这正是
    // §13.3.6「用户仍可保存 desired config，节点退出维护后再由 Reconciler 应用」。
    //
    // 因此这里不能回 502：502 的语义是「保存失败、请重试」，而实际状态是
    // 「已保存、待节点恢复后自动应用」。回 502 会让前端提示失败并诱使用户
    // 反复重试同一编辑。用 200 + 明确的 runtime 状态把真相交回前端。
    return { ok: true, data: forwardView(await reloadOrMinimal(id, workspaceId, revision)) };
  }
  if (runtime && !runtime.ok && runtime.status !== "waiting" && runtime.status !== "in_progress") {
    // 只有确定失败才回 502。waiting 表示 desired/revision 已经可靠落库，
    // 但 outbound command 的 ACK 结果未知；worker 会按同 revision 继续收敛。
    const failed = await loadForwardRow(id, workspaceId);
    return error(502, "apply_failed", runtime.error ?? "rollout 执行失败", {
      apply_error_code: runtime.error_code,
      data: failed ? forwardView(failed) : { id: current.id, revision },
    });
  }

  const updated = await loadForwardRow(id, workspaceId);
  if (!updated) return error(404, "not_found", "端口转发不存在");
  return { ok: true, data: forwardView(updated) };
}

/**
 * V4-WP1 preview：**不写库**，只回答「这次编辑会发生什么」。
 *
 * 与 {@link patchForward} 共用 {@link resolveForwardCandidate} 与
 * {@link computeForwardImpact}，因此 preview 放行 ⇔ update 接受（§13.3.3）。
 */
export async function previewForwardUpdate(
  id: number,
  workspaceId: number,
  patch: ForwardPatchInput,
  userId?: number,
): Promise<ForwardServiceResult<ForwardPreviewResult>> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return error(404, "not_found", "端口转发不存在");

  const resolved = await resolveForwardCandidate(id, workspaceId, patch, userId);
  if (!resolved.ok) return resolved.error;

  const { base, candidate, ctx, validation } = resolved.data;

  const resolvedListenPort = candidate.listen_port ?? current.listen_port ?? null;
  const impact = computeForwardImpact({
    current: base,
    candidate,
    ingressNodeId: ctx.ingress?.node_id ?? null,
    egressNodeId: ctx.egress?.node_id ?? null,
    currentIngressNodeId: current.ingress_node?.node_id ?? null,
    currentEgressNodeId: current.egress_node?.node_id ?? null,
    ingressConnectIp: ctx.ingress?.connect_ip ?? null,
    resolvedListenPort,
    currentResolvedListenPort: current.listen_port ?? null,
    bindingRequired: candidate.mode === "relay" && ctx.bindingExists === false,
  });

  return {
    ok: true,
    data: {
      current: {
        revision: Number(current.config_revision ?? 0),
        config: base,
        apply_status: current.apply_status,
        desired_status: current.desired_status,
      },
      candidate: {
        revision: Number(current.config_revision ?? 0) + 1,
        config: candidate,
      },
      impact,
      validation,
    },
  };
}

/** resolveForwardCandidate 的成功载荷。 */
interface ResolvedCandidate {
  base: ForwardCandidateConfig;
  candidate: ForwardCandidateConfig;
  ctx: ForwardCandidateContext & { userId: number | null; egressTargets: Array<{ host: string; port: number; weight: number; order_by: number }> | null };
  metadataOnly: boolean;
  desiredStatus: ForwardDesiredStatus;
  validation: ForwardValidation;
}

/**
 * 编辑请求的公共前置：读当前 desired → 合并 patch → 读库校验 → 算影响面输入。
 *
 * 这是 §13.3.3「preview 与真实 update 不得各写一份规则」的结构性保证：
 * 两个入口函数体都只有「落库 / 不落库」的差别，前置完全同一份代码。
 */
/**
 * The tls path columns for a resolved candidate.
 *
 * Uses the ONE rule (`tlsPathsForProtocol`) rather than re-checking here: only a
 * tls candidate may carry paths, and it must carry both. A candidate that violates
 * that never reaches this line — `resolveForwardCandidate` rejects it — so this
 * helper only decides what to WRITE, and writing `null` for a non-tls candidate is
 * what keeps a converted row from keeping stale paths.
 */
function tlsPathsForCandidate(candidate: {
  protocol?: string;
  tls_cert_path?: string | null;
  tls_key_path?: string | null;
}): { tls_cert_path: string | null; tls_key_path: string | null } {
  // A candidate always has a protocol by this point (`currentDesiredConfig` fills
  // it from the persisted fact), but the type is optional; an absent protocol is
  // not "tls", so the paths are cleared — the same fail-closed direction the rest
  // of the contract takes.
  const admitted = normalizeForwardProtocol(candidate.protocol);
  if (admitted === null) return { tls_cert_path: null, tls_key_path: null };
  const paths = tlsPathsForProtocol(admitted, candidate.tls_cert_path, candidate.tls_key_path);
  if (!paths.ok) return { tls_cert_path: null, tls_key_path: null };
  return { tls_cert_path: paths.columns.tls_cert_path, tls_key_path: paths.columns.tls_key_path };
}

async function resolveForwardCandidate(
  id: number,
  workspaceId: number,
  patch: ForwardPatchInput,
  userIdOverride?: number,
): Promise<{ ok: true; data: ResolvedCandidate } | { ok: false; error: ForwardServiceError }> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return { ok: false, error: error(404, "not_found", "端口转发不存在") };

  const row = current as unknown as ForwardRevisionRow;
  const base = currentDesiredConfig(row);
  if (base.mode === "relay" && current.egress_pool?.targets?.[0]) {
    base.target_host = current.egress_pool.targets[0].host;
    base.target_port = current.egress_pool.targets[0].port;
  }
  const candidate = mergeForwardCandidate(base, patch);

  // 纯形态校验失败 → 不读库（preview / update 同一短路顺序）。
  const pure = validateForwardCandidate(candidate);
  if (!pure.ok) {
    return {
      ok: false,
      error: error(400, "invalid_input", pure.errors[0] ?? "端口转发参数不合法", {
        data: { errors: pure.errors, reasons: pure.reasons },
      }),
    };
  }

  // 需要读库的上下文：节点归属/能力、端口占用、NodeBinding、端口区间。
  const [ingress, egress, binding, middleNode, middleBindings, portHolders, siblings] = await Promise.all([
    loadWorkspaceNode(candidate.ingress_node_id, workspaceId),
    candidate.egress_node_id === null
      ? Promise.resolve(null)
      : loadWorkspaceNode(candidate.egress_node_id, workspaceId),
    candidate.mode === "relay" && candidate.egress_node_id !== null
      ? db.nodeBinding.findUnique({
          where: {
            ingress_node_id_egress_node_id: {
              ingress_node_id: candidate.ingress_node_id,
              egress_node_id: candidate.egress_node_id,
            },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    // V5.4：中间跳的节点事实 + **两段**许可。三跳路由用到的两条邻接是
    // (入口 → 中间) 与 (中间 → 出口)，而旧的 (入口 → 出口) 那条**不再被使用**
    // （§9 冻结契约第 3 条：相邻两跳之间必须有绑定）。
    candidate.mode === "relay" && candidate.middle_node_id != null
      ? loadWorkspaceNode(candidate.middle_node_id, workspaceId)
      : Promise.resolve(null),
    candidate.mode === "relay" && candidate.middle_node_id != null && candidate.egress_node_id !== null
      ? db.nodeBinding.findMany({
          where: {
            OR: [
              { ingress_node_id: candidate.ingress_node_id, egress_node_id: candidate.middle_node_id },
              { ingress_node_id: candidate.middle_node_id, egress_node_id: candidate.egress_node_id },
            ],
          },
          select: { ingress_node_id: true, egress_node_id: true },
        })
      : Promise.resolve([]),
    candidate.listen_port === null
      ? Promise.resolve([])
      : db.nodePortLease.findMany({
          where: { node_id: candidate.ingress_node_id, port: candidate.listen_port, status: "active" },
          select: { tunnel_id: true, port: true },
        }),
    db.tunnel.findMany({
      where: {
        ingress_node_id: candidate.ingress_node_id,
        listen_port: candidate.listen_port ?? undefined,
      },
      select: { id: true, listen_port: true },
    }),
  ]);

  if (!ingress) {
    return { ok: false, error: error(404, "not_found", "入口节点不存在") };
  }
  if (candidate.mode === "relay" && !egress) {
    return { ok: false, error: error(404, "not_found", "出口节点不存在") };
  }
  // V5.4：三跳的中间跳必须存在，且**两段**邻接都必须有许可。缺任何一段都拒绝 ——
  // 放行的后果是一条"中间那一段没有许可"的链路，它会在下发时才炸，且错误指向不了根因。
  if (candidate.mode === "relay" && candidate.middle_node_id != null) {
    if (!middleNode) return { ok: false, error: error(404, "not_found", "中间跳节点不存在") };
    const hasIngressToMiddle = middleBindings.some(
      (b) => b.ingress_node_id === candidate.ingress_node_id && b.egress_node_id === candidate.middle_node_id,
    );
    const hasMiddleToEgress = middleBindings.some(
      (b) => b.ingress_node_id === candidate.middle_node_id && b.egress_node_id === candidate.egress_node_id,
    );
    if (!hasIngressToMiddle || !hasMiddleToEgress) {
      return {
        ok: false,
        error: error(409, "binding_required", "三跳路由要求入口→中间、中间→出口两段都已绑定"),
      };
    }
  }

  // ── V4-WP5 §13.4.2：把 Forward（迁移）到新节点前先过准入 ──
  //
  // 只判「新选的节点」，不判「当前已在跑的节点」：maintenance 的语义是
  // 「不接受新业务 + 存量 runtime 尽量保持」，用户**可以**在维护期间保存
  // 与当前节点无关的编辑（比如改名、改目标），那种编辑不应被这里挡下。
  // 一旦这次编辑真的要把 runtime 挪到某个节点上，那个节点必须 active。
  //
  // 注意与 rollout VALIDATE 的分工：这里回答「这次编辑选的节点能不能选」；
  // rollout 那边回答「这一刻允不允许下发」（preview 合法 ≠ 立刻应用，
  // §13.3.6 允许保存 desired 后等节点退出维护）。两者都必须存在。
  //
  // 「新选的节点」直接用刚加载的 `ingress` / `egress` 行来比，**不要**写成
  // `ctx.ingress?.id`：`ctx` 在下面才构造（它的构造依赖本次读库的结果），
  // 在它声明之前引用就是 TDZ —— CI typecheck 会以 TS2448/TS2454 直接红掉。
  // 语义完全等价：ctx.ingress 就是稍后那个对象字面量对同一行的投影。
  const ingressChanged =
    ingress.id !== Number(current.ingress_node_id ?? 0);
  const egressChanged =
    (candidate.mode === "relay" ? Number(candidate.egress_node_id ?? 0) : 0) !==
    Number(current.egress_node_id ?? 0);
  if (ingressChanged) {
    const rejected = nodeAdmissionError(ingress);
    if (rejected) {
      return {
        ok: false,
        error: error(409, rejected.code, rejected.message, { data: rejected.data }),
      };
    }
  }
  if (egressChanged && egress) {
    const rejected = nodeAdmissionError(egress);
    if (rejected) {
      return {
        ok: false,
        error: error(409, rejected.code, rejected.message, { data: rejected.data }),
      };
    }
  }

  // 端口占用：DB 租约 + 同节点其它 Forward（含 legacy DIRECT）。
  const takenByOther = new Set<number>();
  for (const h of portHolders) {
    if (h.tunnel_id !== null && h.tunnel_id !== id && h.port === candidate.listen_port) {
      takenByOther.add(h.port);
    }
  }
  for (const s of siblings) {
    if (
      s.id !== id &&
      candidate.listen_port !== null &&
      s.listen_port === candidate.listen_port
    ) {
      takenByOther.add(candidate.listen_port);
    }
  }
  const portHolderList = [...takenByOther].map((port) => ({ tunnel_id: -1, port }));

  const ctx: ForwardCandidateContext & {
    userId: number | null;
    egressTargets: Array<{ host: string; port: number; weight: number; order_by: number }> | null;
  } = {
    ingress: {
      id: ingress.id,
      node_id: ingress.node_id,
      role: ingress.role,
      connect_ip: ingress.connect_ip,
      node_group_id: ingress.node_group_id,
    },
    egress: egress
      ? {
          id: egress.id,
          node_id: egress.node_id,
          role: egress.role,
          node_group_id: egress.node_group_id,
          lb_strategy: egress.lb_strategy,
        }
      : null,
    portHolders: portHolderList,
    bindingExists: binding ? true : candidate.mode === "relay" ? false : null,
    ingressRangeConfigured: ingress.port_range_min !== null && ingress.port_range_max !== null,
    userId: userIdOverride ?? null,
    egressTargets:
      candidate.target_host && candidate.target_port
        ? [{
            host: candidate.target_host,
            port: candidate.target_port,
            weight: 1,
            order_by: 1000,
          }]
        : current.egress_pool?.targets
          ? (current.egress_pool.targets as unknown as Array<{
              host: string;
              port: number;
              weight: number;
              order_by: number;
            }>)
          : null,
  };

  const validation = validateForwardCandidateFull(candidate, ctx);
  if (!validation.ok) {
    const code =
      validation.reasons.includes("binding_required")
        ? "binding_required"
        : validation.reasons.includes("port_conflict")
          ? "port_conflict"
          : validation.reasons.includes("node_unavailable")
            ? "conflict"
            : validation.reasons.includes("not_found")
              ? "not_found"
              : "invalid_input";
    return {
      ok: false,
      error: error(
        code === "not_found" ? 404 : code === "binding_required" || code === "port_conflict" || code === "conflict" ? 409 : 400,
        code,
        validation.errors[0] ?? "端口转发参数不合法",
        { data: { errors: validation.errors, reasons: validation.reasons } },
      ),
    };
  }

  if (!isMetadataOnlyPatch(base, candidate)) {
    const admittedProtocol = normalizeForwardProtocol(candidate.protocol);
    if (admittedProtocol === null) {
      return { ok: false, error: error(400, "invalid_input", "当前版本不支持该转发协议") };
    }
    const rejected = await checkForwardRuntimeUse(workspaceId, {
      user_id: current.user_id,
      in_node_group_id: ingress.node_group_id,
      out_node_group_id: candidate.mode === "relay" ? egress?.node_group_id ?? null : null,
      protocol: admittedProtocol,
    });
    if (rejected) {
      return { ok: false, error: error(403, rejected.reason, rejected.message, {
        data: { error_layer: rejected.error_layer },
      }) };
    }
  }

  // suspended 编辑：§13.3.6「保存最新 desired revision → 不启动 runtime」。
  // 目标 desired_status 取当前值，suspend 的 desired 是 inactive 已由运行动作维护。
  const desiredStatus: ForwardDesiredStatus =
    current.apply_status === "suspended" ? "inactive" : "active";

  return {
    ok: true,
    data: {
      base,
      candidate,
      ctx,
      metadataOnly: isMetadataOnlyPatch(base, candidate),
      desiredStatus,
      validation,
    },
  };
}

export async function runForwardAction(
  id: number,
  action: ForwardAction,
  workspaceId: number,
): Promise<ForwardServiceResult<ReturnType<typeof forwardView>>> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return error(404, "not_found", "端口转发不存在");

  const result = await runTunnelActionApi(id, action, workspaceId, {
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) {
    return error(
      TUNNEL_API_ERROR_STATUS[result.code],
      result.code,
      result.message,
      { apply_error_code: result.apply_error_code, error_layer: result.error_layer, data: result.reason ? { reason: result.reason } : undefined },
    );
  }

  const after = await loadForwardRow(id, workspaceId);
  if (!after) return error(404, "not_found", "端口转发不存在");
  return { ok: true, data: forwardView(after) };
}

/**
 * V4-WP9 §13.6：批量 retry / suspend / resume。
 *
 * 形态约束（与 `forward-batch.ts` 的决策文档一致）：
 *   · **顺序执行**，不并发：每个 action 都可能触发 rollout（下发 + 租约），
 *     并发对同一入口节点发起 N 个动作会让 apply 状态机互相踩踏；
 *   · **逐条结果**：一条失败不影响其它条，返回 `{ id, ok, code, message }`，
 *     部分失败对用户可见——这是「批量删除不做」的同一条理由的反面（删除的
 *     部分成功无法解释，retry/suspend 的部分成功可以）；
 *   · 工作空间作用域由 `runForwardAction` 内部检查（越权 id 得到 404，
 *     不泄漏其它工作空间的行是否存在）。
 */
export async function runForwardBatch(
  ids: number[],
  action: ForwardBatchAction,
  workspaceId: number,
  authorize?: (row: { user_id: number }) => boolean,
): Promise<ForwardBatchPayload> {
  const results: ForwardBatchItemResult[] = [];
  for (const id of ids) {
    // Scope before RBAC: a foreign ID remains 404, never an existence oracle.
    if (authorize) {
      const row = await loadForwardRow(id, workspaceId);
      if (!row) {
        results.push({ id, ok: false, apply_status: null, code: "not_found", message: "端口转发不存在" });
        continue;
      }
      if (!authorize(row)) {
        // Same code as the single-resource endpoint: a per-item RBAC refusal.
        results.push({ id, ok: false, apply_status: null, code: "forbidden", error_layer: "rbac", message: "无权操作该端口转发" });
        continue;
      }
    }
    const outcome = await runForwardAction(id, action, workspaceId);
    if (outcome.ok) {
      results.push({
        id,
        ok: true,
        apply_status: outcome.data.apply_status ?? null,
      });
    } else {
      results.push({
        id,
        ok: false,
        apply_status: null,
        code: outcome.code,
        message: outcome.message,
      });
    }
  }
  return { action, ...forwardBatchSummary(results), results };
}

export type ForwardBatchPayload = {
  action: ForwardBatchAction;
} & ForwardBatchSummary & {
  results: ForwardBatchItemResult[];
};

export async function deleteForward(
  id: number,
  workspaceId: number,
): Promise<ForwardServiceResult<{ ok: true }>> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return error(404, "not_found", "端口转发不存在");

  const dedicatedPoolId =
    current.tunnel_mode === "relay" &&
    current.egress_pool?.name === `forward-${id}`
      ? current.egress_pool.id
      : null;

  const result = await runTunnelActionApi(id, "delete", workspaceId, {
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) {
    return error(
      TUNNEL_API_ERROR_STATUS[result.code],
      result.code,
      result.message,
      { apply_error_code: result.apply_error_code, error_layer: result.error_layer, data: result.reason ? { reason: result.reason } : undefined },
    );
  }

  if (dedicatedPoolId != null) {
    await db.egressPool
      .delete({ where: { id: dedicatedPoolId } })
      .catch(() => {});
  }

  // ── V5.5 WP15：删除 Forward 必须**释放远端腿** ──
  //
  // 本地 runtime 由 `runTunnelActionApi(delete)` 撤掉，但远端那条腿不在本机：
  // 它不会随 tunnel 行一起消失（`federation_placement.tunnel_id` 刻意没有外键，
  // 免得删 Forward 抹掉联邦历史）。不释放的后果是对面留一条继续监听的孤儿 runtime
  // 与一个被占着的端口 —— G4 的同族泄漏，且它在另一台面板上，本机看不见。
  //
  // 顺序按契约 §3.3（先本地入口停 → 再远端释放）：这里本地已经删完。
  // 释放失败不把删除回滚成错误（用户视角的删除已经成功，且租约到期会自然停服），
  // 但必须留下响亮的一行，并让 placement 行停在 degraded 等对账/运维收尾。
  const releases = await releaseStaleFederatedEgressForTunnel(id, -1).catch(() => null);
  if (releases && releases.failed.length > 0) {
    console.warn(
      `[forward] 删除 Forward ${id} 后仍有远端出口腿未确认释放：` +
        releases.failed.map((f) => `${f.intent_id}(${f.code})`).join(", "),
    );
  }

  return { ok: true, data: { ok: true } };
}
