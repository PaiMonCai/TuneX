/**
 * Forward rollout executor ownership lease and runtime confirmation.
 *
 * This module owns concurrency/confirmation mechanics only; rollout step order,
 * compensation and phase transitions remain in forward-rollout-exec.ts.
 */
import { randomUUID } from "node:crypto";
import { Orchestrator } from "./orchestrator.ts";
import type { RolloutStep } from "./forward-rollout.ts";
import type { RolloutExecContext, RolloutDeps, RolloutRowView } from "./forward-rollout-state.ts";

/* ================================================================== */
/* 单执行器 lease + runtime 事实确认                                    */
/* ================================================================== */

/**
 * 一条远程 ACK 最长等 15s；RELAY 补偿可能连续做多次远程操作。90s 足够当前
 * owner 完成一个阶段，又能让崩溃后的 worker 在 S10 的 180s 窗口内接管。
 */
export const ROLLOUT_EXECUTOR_LEASE_MS = 90_000;
/** Agent state report 周期 30s；多给 5s 抖动，先等事实再决定是否重发。 */
export const ROLLOUT_RUNTIME_CONFIRM_WAIT_MS = 35_000;
const ROLLOUT_RUNTIME_CONFIRM_POLL_MS = 1_000;
/**
 * Agent pipeTracker.Stop() 的 drainTimeout 是 3s。Same-node listener replacement
 * 在 ACK 前已经把新 listener 放进 registry，但旧 listener 的 Stop 在后台 goroutine
 * 中完成；backend 释放旧 durable lease 前多留 500ms 调度余量，避免旧 Agent
 * port guard 尚未释放时控制面把该端口重新分配出去。
 */
export const SAME_NODE_LISTENER_RETIRE_WAIT_MS = 3_500;

export function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function claimRolloutExecutor(
  rolloutId: number,
  deps: RolloutDeps,
): Promise<{ token: string | null; row: RolloutRowView | null }> {
  const row = (await deps.db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
  if (!row) return { token: null, row: null };
  if (row.phase === "done" || row.phase === "failed" || row.phase === "degraded") {
    return { token: null, row };
  }

  const now = deps.now?.() ?? new Date();
  const observedOwner = row.executor_owner ?? null;
  const observedLease = row.executor_lease_until ?? null;
  const leaseDate = asDate(observedLease);
  if (observedOwner && leaseDate && leaseDate.getTime() > now.getTime()) {
    return { token: null, row };
  }

  const token = randomUUID();
  const leaseUntil = new Date(now.getTime() + ROLLOUT_EXECUTOR_LEASE_MS);
  // 对“刚才读到的 owner + lease + phase”做精确 CAS。两个 executor 即使同时
  // 读到 NULL，也只有一个能把 NULL→token；过期接管同理。
  const claimed = (await deps.db.forwardRollout.updateMany({
    where: {
      id: rolloutId,
      phase: row.phase,
      executor_owner: observedOwner,
      executor_lease_until: observedLease,
    },
    data: {
      executor_owner: token,
      executor_lease_until: leaseUntil,
    },
  })) as { count: number };

  return claimed.count > 0 ? { token, row } : { token: null, row };
}

export async function renewRolloutExecutor(rolloutId: number, token: string, deps: RolloutDeps): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const renewed = (await deps.db.forwardRollout.updateMany({
    where: { id: rolloutId, executor_owner: token },
    data: { executor_lease_until: new Date(now.getTime() + ROLLOUT_EXECUTOR_LEASE_MS) },
  })) as { count: number };
  return renewed.count > 0;
}

export async function releaseRolloutExecutor(rolloutId: number, token: string, deps: RolloutDeps): Promise<void> {
  await deps.db.forwardRollout
    .updateMany({
      where: { id: rolloutId, executor_owner: token },
      data: { executor_owner: null, executor_lease_until: null },
    })
    .catch(() => {});
}

export function runtimeResourceId(step: RolloutStep, ctx: RolloutExecContext): string | null {
  if (step.kind === "prepare_egress" || step.kind === "cutover_egress") {
    return Orchestrator.egressTunnelId(ctx.tunnelId);
  }
  if (step.kind === "cutover_ingress") {
    return ctx.desired.mode === "relay"
      ? Orchestrator.relayTunnelId(ctx.tunnelId)
      : Orchestrator.directTunnelId(ctx.tunnelId);
  }
  return null;
}

/**
 * ACK timeout 后优先问 Agent 最近一次**具体 resource** 自报，而不是再猜一次。
 * 只有同 node + 同 resource 的 revision >= desired 才算确认；绝不使用节点级
 * reported_revision（它是 max，可能来自别的 tunnel，会制造假阳性）。
 */
export async function runtimeConfirmsStepApplied(
  step: RolloutStep,
  ctx: RolloutExecContext,
  deps: RolloutDeps,
): Promise<boolean> {
  const reader = deps.db.nodeStateReport?.findUnique;
  const nodeId = step.node_id;
  const resourceId = runtimeResourceId(step, ctx);
  if (!reader || nodeId == null || !resourceId) return false;

  const deadline = (deps.now?.() ?? new Date()).getTime() + ROLLOUT_RUNTIME_CONFIRM_WAIT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const snap = (await reader({
      where: { node_id: nodeId },
      select: { tunnels: true, reported_at: true },
    }).catch(() => null)) as { tunnels?: unknown; reported_at?: Date | string | null } | null;

    if (snap && Array.isArray(snap.tunnels)) {
      for (const raw of snap.tunnels) {
        if (!raw || typeof raw !== "object") continue;
        const tunnel = raw as Record<string, unknown>;
        if (String(tunnel.id ?? "") !== resourceId) continue;
        const revision = Number(tunnel.revision);
        // resource revision 单调递增；只要 >= desired，就已经是比任何 wall-clock
        // 更强的事实。不要再拿 rollout.updated_at/lease heartbeat 当 freshness 闸门。
        if (Number.isFinite(revision) && revision >= ctx.revision) return true;
      }
    }

    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (nowMs >= deadline) return false;
    await sleep(Math.min(ROLLOUT_RUNTIME_CONFIRM_POLL_MS, Math.max(0, deadline - nowMs)));
  }
}

