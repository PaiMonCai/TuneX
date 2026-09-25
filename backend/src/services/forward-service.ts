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
  runTunnelAction as runTunnelActionApi,
  TUNNEL_API_ERROR_STATUS,
  type TunnelAction,
} from "./tunnel-api.ts";

export type ForwardMode = "direct" | "relay";
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
  mode?: ForwardMode;
  apply_status?: string;
  keyword?: string;
}

export interface ForwardPatchInput {
  name?: string;
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

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 60) {
      return error(400, "invalid_input", "转发名称不合法");
    }
    await db.tunnel.update({
      where: { id: current.id },
      data: { name },
    });
  }

  const updated = await loadForwardRow(id, workspaceId);
  if (!updated) return error(404, "not_found", "端口转发不存在");
  return { ok: true, data: forwardView(updated) };
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
