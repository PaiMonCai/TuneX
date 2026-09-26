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
import { db } from "../db.ts";
import {
  countWorkspaceTunnels,
  sumWorkspaceTraffic,
  withWorkspaceQuotaLock,
} from "./policy-service.ts";
import { checkTunnelCreation } from "./capability-policy.ts";
import { getOrchestrator } from "./relay-wiring.ts";
import { reapplyDirectTunnel, reapplyRelayTunnel } from "./scheduler.ts";
import {
  FORWARD_REVISION_ERROR_CODES,
  ForwardRevisionError,
  computeForwardImpact,
  createForwardRevision,
  currentDesiredConfig,
  isMetadataOnlyPatch,
  mergeForwardCandidate,
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

export type ForwardMode = "direct" | "relay";
export type ForwardApplyStatus = "pending" | "applying" | "active" | "error" | "suspended";
export type ForwardAction = Extract<TunnelAction, "retry" | "suspend" | "resume">;
export interface ForwardCreateInput {
  name: string;
  mode: ForwardMode;
  ingress_node_id: number;
  egress_node_id?: number | null;
  listen_port?: number | null;
  target_host: string;
  target_port: number;
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
  listen_port?: number | null;
  target_host?: string | null;
  target_port?: number | null;
  /** V4-WP1 §13.3.3：乐观并发；不匹配 → 409 revision_conflict。 */
  expected_revision?: number | null;
}

export type ForwardServiceError = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 502 | 503;
  code: string;
  message: string;
  apply_error_code?: string;
  data?: unknown;
};

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
  extra?: Pick<ForwardServiceError, "apply_error_code" | "data">,
): ForwardServiceError {
  return { ok: false, status, code, message, ...extra };
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

  return {
    id: t.id,
    name: t.name,
    protocol: "tcp" as const,
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

export async function listForwards(workspaceId: number, input: ForwardListInput = {}) {
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
    where.OR = [
      { name: { contains: keyword } },
      { remote_host: { contains: keyword } },
      { ingress_node: { node_id: { contains: keyword } } },
      { egress_node: { node_id: { contains: keyword } } },
    ];
  }

  const rows = await db.tunnel.findMany({
    where,
    orderBy: [{ order_by: "asc" }, { id: "desc" }],
    include: forwardInclude,
  });
  return rows.map(forwardView);
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
  if (input.mode === "direct" && egressId !== null) {
    return error(400, "invalid_input", "DIRECT 转发不能指定出口节点");
  }
  if (input.mode === "relay" && egressId === null) {
    return error(400, "invalid_input", "RELAY 转发必须指定出口节点");
  }

  const ingress = await loadWorkspaceNode(input.ingress_node_id, workspaceId);
  if (!ingress) return error(404, "not_found", "入口节点不存在");
  if (ingress.role !== "ingress" && ingress.role !== "both") {
    return error(409, "conflict", "该节点不具备入口能力");
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
        protocol: "tcp",
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
          tunnel_type: "tcp",
          category: "port_forward",
          listen_ip: "0.0.0.0",
          listen_port: input.listen_port ?? null,
          listen_protocol: ["tcp"],
          status: "active",
          forward_addresses: input.mode === "direct" ? [target] : [],
          forward_addresses_protocol:
            input.mode === "direct" ? ["tcp"] : [],
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
          desired_status: "inactive",
          apply_status: "pending",
          config_revision: 0,
          applied_revision: null,
          remote_host:
            input.mode === "direct" ? input.target_host.trim() : null,
          remote_port: input.mode === "direct" ? input.target_port : null,
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
      const failed = await loadForwardRow(tunnelId, workspaceId);
      return error(502, "apply_failed", applied.error, {
        apply_error_code: applied.error_code,
        data: failed ? forwardView(failed) : { id: tunnelId },
      });
    }
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
): Promise<ForwardServiceResult<ReturnType<typeof forwardView>>> {
  const current = await loadForwardRow(id, workspaceId);
  if (!current) return error(404, "not_found", "端口转发不存在");

  // ── V4-WP1 §13.3.3：校验逻辑只有一个实现 ──
  // patchForward 与 previewForwardUpdate 都走 resolveForwardCandidate() → 同一个
  // 合并 + 同一个校验 + 同一个影响面计算；两者只差「是否落库」。
  const resolved = await resolveForwardCandidate(id, workspaceId, patch);
  if (!resolved.ok) return resolved.error;

  const { base, candidate, ctx, metadataOnly, desiredStatus } = resolved.data;

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

  // 写不可变 snapshot + 推进 revision + 同步兼容投影列（单事务）。
  let revision: number;
  try {
    const written = await createForwardRevision({
      tunnelId: current.id,
      candidate,
      desiredStatus,
      createdById: ctx.userId,
      egressTargets: ctx.egressTargets,
      resolvedListenIp: ctx.ingress?.connect_ip
        ? String(ctx.ingress.connect_ip).split(",").map((x) => x.trim()).find(Boolean) ?? null
        : null,
      egressPort: candidate.mode === "relay" ? current.egress_port ?? null : null,
      egressPoolId: candidate.mode === "relay" ? current.egress_pool?.id ?? null : null,
    });
    revision = written.revision;
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

  // RELAY 需要新 NodeBinding 时先补建（§13.3.1：Binding 是可复用基础设施关系，
  // 修改 Forward 不自动删除，但新建必须显式）。
  if (candidate.mode === "relay" && ctx.egress && ctx.bindingExists === false) {
    await db.nodeBinding
      .create({
        data: {
          ingress_node_id: ctx.ingress!.id,
          egress_node_id: ctx.egress.id,
        },
      })
      .catch(() => {});
  }

  // ── WP1 边界：只落 desired，把 apply 交给既有 reconciler ──
  // apply_status 置 pending 让 reconciler 的 revision_behind / fill_missing_runtime
  // 按新 revision 收敛；WP3 的 Orchestrator 落地时替换这个收敛出口。
  await db.tunnel
    .update({
      where: { id: current.id },
      data: { apply_status: "pending", apply_error_code: null, apply_error: null },
    })
    .catch(() => {});

  const orchestrator = getOrchestrator();
  if (orchestrator) {
    const applied =
      candidate.mode === "direct"
        ? await reapplyDirectTunnel(current.id, orchestrator).catch(() => null)
        : await reapplyRelayTunnel(current.id, orchestrator).catch(() => null);
    if (applied && !applied.ok) {
      // 失败保留 Tunnel 与 revision 历史（§4.1 铁律）：只回带错误，不删行。
      const failed = await loadForwardRow(id, workspaceId);
      return error(502, "apply_failed", applied.error, {
        apply_error_code: applied.error_code,
        data: failed ? forwardView(failed) : { id: current.id, revision },
      });
    }
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
  const [ingress, egress, binding, portHolders, siblings] = await Promise.all([
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
    candidate.listen_port === null
      ? Promise.resolve([])
      : db.nodePortLease.findMany({
          where: { port: candidate.listen_port, status: "active" },
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
    },
    egress: egress
      ? { id: egress.id, node_id: egress.node_id, role: egress.role }
      : null,
    portHolders: portHolderList,
    bindingExists: binding ? true : candidate.mode === "relay" ? false : null,
    ingressRangeConfigured: ingress.port_range_min !== null && ingress.port_range_max !== null,
    userId: userIdOverride ?? null,
    egressTargets: current.egress_pool?.targets
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
      { apply_error_code: result.apply_error_code },
    );
  }

  const after = await loadForwardRow(id, workspaceId);
  if (!after) return error(404, "not_found", "端口转发不存在");
  return { ok: true, data: forwardView(after) };
}

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
      { apply_error_code: result.apply_error_code },
    );
  }

  if (dedicatedPoolId != null) {
    await db.egressPool
      .delete({ where: { id: dedicatedPoolId } })
      .catch(() => {});
  }

  return { ok: true, data: { ok: true } };
}
