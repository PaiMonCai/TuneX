/**
 * V5.3 WP9 —— 归属租约（fencing）。
 *
 * 这是整个 V5 里唯一一处"猜错就会同时服务两份流量"的地方（§8.2），所以规则写死在这里，
 * 调用方不许各自实现一遍：
 *
 *   1. **epoch 单调递增**。任何归属变更都是 `epoch + 1`；`epoch` 永不回退。
 *      "最后写入者获胜"被明确禁止——那是双主的同义词。
 *   2. **到期即停（fail-safe）**。租约到期未续 = 该节点不允许继续服务。
 *      "可能还有另一个主人"比"短暂中断"更危险。
 *   3. **两阶段交接**。新主人只能在旧租约**已过期或被显式释放**之后拿到归属。
 *      "先给新的、再收旧的"必然产生双主窗口。
 *   4. **续约只有现任能续**。别人续不掉，也抢不走。
 *
 * 本模块只管归属事实；它不下发命令、不碰 desired 配置。
 */

import { db } from "../db.ts";

/**
 * 租约有效期。取值的理由：
 *   · 太短 → 面板一次抖动就让在服务的 owner "自己把自己停了"（可用性损失）；
 *   · 太长 → 双主的窗口被拉长（安全性损失）。
 * 30s 与 Agent 状态上报/观测周期同频，因此一次正常上报就能覆盖续约；连续三次上报
 * 失败才会真的到期，这个比例是刻意选的。
 */
export const LEASE_TTL_SECONDS = 30;

/** 续约时的宽限期：面板必须在这之前续约，否则视为放弃。 */
export const LEASE_RENEW_MARGIN_SECONDS = 10;

export interface PlacementLeaseRow {
  tunnel_id: number;
  owner_node_id: number;
  epoch: number;
  lease_expires_at: Date;
  revision: number;
}

export type LeaseClaimResult =
  | { ok: true; lease: PlacementLeaseRow; epoch: number; changed_owner: boolean }
  | { ok: false; reason: "not_owner" | "not_expired" | "not_found"; current?: PlacementLeaseRow };

/** 当前租约（可能已过期——到期判定由调用方按它自己的时钟做，见 `isLeaseExpired`）。 */
export async function loadLease(tunnelId: number): Promise<PlacementLeaseRow | null> {
  const row = await db.placementLease.findUnique({
    where: { tunnel_id: tunnelId },
    select: {
      tunnel_id: true,
      owner_node_id: true,
      epoch: true,
      lease_expires_at: true,
      revision: true,
    },
  });
  return row ?? null;
}

/** 租约是否已过期。`now` 是参数：同一个判定里只能用同一个时刻。 */
export function isLeaseExpired(lease: PlacementLeaseRow | null, now: Date): boolean {
  if (!lease) return true;
  return lease.lease_expires_at.getTime() <= now.getTime();
}

/**
 * 认领或续约归属。
 *
 * - 没有租约 → 建立，`epoch = 1`（从 1 起，让 0 明确表示"从未归属"）；
 * - 现任续约 → 同 epoch，只推到期时间；
 * - 换人 → 只有**旧租约已过期**才允许，且 `epoch + 1`。
 *
 * 返回 `not_expired` 是**正确行为**而不是异常：它意味着"有人可能还在服务"，
 * 此时把归属交出去就是在制造双主。
 */
export async function claimLease(input: {
  tunnelId: number;
  nodeId: number;
  revision: number;
  now: Date;
  ttlSeconds?: number;
}): Promise<LeaseClaimResult> {
  const ttl = input.ttlSeconds ?? LEASE_TTL_SECONDS;
  const expiresAt = new Date(input.now.getTime() + ttl * 1000);
  const current = await loadLease(input.tunnelId);

  if (current === null) {
    const created = await db.placementLease.create({
      data: {
        tunnel_id: input.tunnelId,
        owner_node_id: input.nodeId,
        epoch: 1,
        lease_expires_at: expiresAt,
        revision: input.revision,
      },
      select: {
        tunnel_id: true,
        owner_node_id: true,
        epoch: true,
        lease_expires_at: true,
        revision: true,
      },
    });
    return { ok: true, lease: created, epoch: created.epoch, changed_owner: true };
  }

  if (current.owner_node_id === input.nodeId) {
    // Renewal. Same epoch on purpose: renewal is not a new generation, and bumping it
    // would make every heartbeat look like an ownership change to the agent's
    // stale-epoch guard.
    const renewed = await db.placementLease.update({
      where: { tunnel_id: input.tunnelId },
      data: { lease_expires_at: expiresAt, revision: input.revision },
      select: {
        tunnel_id: true,
        owner_node_id: true,
        epoch: true,
        lease_expires_at: true,
        revision: true,
      },
    });
    return { ok: true, lease: renewed, epoch: renewed.epoch, changed_owner: false };
  }

  // Ownership move: only AFTER the old lease has expired (two-phase handover).
  if (!isLeaseExpired(current, input.now)) {
    return { ok: false, reason: "not_expired", current };
  }
  const moved = await db.placementLease.update({
    where: { tunnel_id: input.tunnelId },
    data: {
      owner_node_id: input.nodeId,
      epoch: current.epoch + 1,
      lease_expires_at: expiresAt,
      revision: input.revision,
    },
    select: {
      tunnel_id: true,
      owner_node_id: true,
      epoch: true,
      lease_expires_at: true,
      revision: true,
    },
  });
  return { ok: true, lease: moved, epoch: moved.epoch, changed_owner: true };
}

/**
 * 显式释放归属（停用 Forward、主动迁移都走它）。
 *
 * 只允许现任释放；释放把到期时刻设为"现在"，于是下一次认领立刻可以发生——
 * 这正是**显式**交接与"等租约自己过期"的区别，也是运维停机时的正常路径。
 */
export async function releaseLease(input: {
  tunnelId: number;
  nodeId: number;
  now: Date;
}): Promise<{ ok: true } | { ok: false; reason: "not_owner" | "not_found" }> {
  const current = await loadLease(input.tunnelId);
  if (current === null) return { ok: false, reason: "not_found" };
  if (current.owner_node_id !== input.nodeId) return { ok: false, reason: "not_owner" };
  await db.placementLease.update({
    where: { tunnel_id: input.tunnelId },
    data: { lease_expires_at: input.now, revision: current.revision },
  });
  return { ok: true };
}
