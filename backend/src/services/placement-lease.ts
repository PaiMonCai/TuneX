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
 * 租约有效期（秒）。
 *
 * **必须显著大于 Agent 的上报周期（30s）**，而不是等于它。第一版把它设成 30s（"同频"），
 * 实现者立刻指出了真实后果：截止时刻恰好落在下一次上报**发出**的瞬间，而续约要等
 * 面板处理 + 往返之后才回到 Agent —— 于是每个周期都有一个 δ 宽（10~200ms）的窗口，
 * 那一刻租约**确实**已过期，Agent 的扫描会忠实地看到一个过期租约并停掉隧道。
 * 每个隧道每周期 1~10% 的概率，而且（在续约路径修好之前）会粘住。
 *
 * 90s = 3 × 上报周期：连续三次上报都没回来才认为归属丢失。**注意这是"多久算丢
 * 归属"的租约 TTL，不是"多久算离线"**（后者是 `node-lifecycle.CONNECTION_ONLINE_WINDOW_MS`）：
 * 两者今天数值相同（同一物理节拍），但一个是所有权、一个是存活，语义不得混用；
 * 数值关系由 `services/__tests__/freshness-windows.test.ts` 钉住。取舍写在明面上：
 *   · 太短 → 面板一次抖动就让在服务的 owner 自停（可用性损失）；
 *   · 太长 → 双主窗口被拉长（安全性损失）；
 * 3 个周期的量级是"抖动不致停、真分区必停"的最小值。
 */
export const LEASE_TTL_SECONDS = 90;

export interface PlacementLeaseRow {
  tunnel_id: number;
  owner_node_id: number;
  epoch: number;
  lease_expires_at: Date;
  revision: number;
}

export type LeaseClaimResult =
  | { ok: true; lease: PlacementLeaseRow; epoch: number; changed_owner: boolean }
  | {
      ok: false;
      /**
       * `not_expired` = 有人可能还在服务（两阶段交接的正确拒绝）；
       * `lost_race`   = 并发的认领里别人先写成功（重读后再决定）。
       */
      reason: "not_owner" | "not_expired" | "not_found" | "lost_race";
      current?: PlacementLeaseRow;
    };

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

  if (current.owner_node_id === input.nodeId && !isLeaseExpired(current, input.now)) {
    // Live-owner renewal is a CAS against the exact lease generation and expiry
    // we observed. Without the expiry predicate, a concurrent explicit release
    // can be overwritten by this renewal and the released owner is resurrected.
    const renewed = await db.placementLease.updateMany({
      where: {
        tunnel_id: input.tunnelId,
        owner_node_id: input.nodeId,
        epoch: current.epoch,
        lease_expires_at: current.lease_expires_at,
      },
      data: {
        lease_expires_at: expiresAt,
        revision: Math.max(current.revision, input.revision),
      },
    });
    if (renewed.count === 0) {
      const fresh = await loadLease(input.tunnelId);
      if (
        fresh !== null &&
        fresh.owner_node_id === input.nodeId &&
        fresh.epoch === current.epoch &&
        !isLeaseExpired(fresh, input.now)
      ) {
        // Another renewal from the same owner won the race. The resulting fact is
        // equivalent for this caller, so converge on it instead of inventing a failure.
        return { ok: true, lease: fresh, epoch: fresh.epoch, changed_owner: false };
      }
      return { ok: false, reason: "lost_race", current: fresh ?? undefined };
    }
    const after = await loadLease(input.tunnelId);
    if (after === null) return { ok: false, reason: "not_found" };
    return { ok: true, lease: after, epoch: after.epoch, changed_owner: false };
  }

  // A live lease owned by someone else cannot move yet.
  if (!isLeaseExpired(current, input.now)) {
    return { ok: false, reason: "not_expired", current };
  }

  // Expiry is a fencing boundary even when the same physical node comes back.
  // Re-acquisition must advance epoch; silently extending an expired row would
  // let a stale runtime from the old generation become authoritative again.
  const moved = await db.placementLease.updateMany({
    where: {
      tunnel_id: input.tunnelId,
      epoch: current.epoch,
      owner_node_id: current.owner_node_id,
      lease_expires_at: current.lease_expires_at,
    },
    data: {
      owner_node_id: input.nodeId,
      epoch: current.epoch + 1,
      lease_expires_at: expiresAt,
      revision: input.revision,
    },
  });
  if (moved.count === 0) {
    const fresh = await loadLease(input.tunnelId);
    if (
      fresh !== null &&
      fresh.owner_node_id === input.nodeId &&
      fresh.epoch > current.epoch &&
      !isLeaseExpired(fresh, input.now)
    ) {
      return {
        ok: true,
        lease: fresh,
        epoch: fresh.epoch,
        changed_owner: current.owner_node_id !== input.nodeId,
      };
    }
    return { ok: false, reason: "lost_race", current: fresh ?? undefined };
  }
  const after = await loadLease(input.tunnelId);
  if (after === null) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    lease: after,
    epoch: after.epoch,
    changed_owner: current.owner_node_id !== input.nodeId,
  };
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
}): Promise<
  { ok: true } |
  { ok: false; reason: "not_owner" | "not_found" | "lost_race" }
> {
  const current = await loadLease(input.tunnelId);
  if (current === null) return { ok: false, reason: "not_found" };
  if (current.owner_node_id !== input.nodeId) return { ok: false, reason: "not_owner" };

  // Release is a fencing write too. A read-then-update by tunnel_id alone can
  // expire a *newer* generation if ownership/renewal changes between these two
  // statements. Match the exact generation + expiry fact we observed.
  const released = await db.placementLease.updateMany({
    where: {
      tunnel_id: input.tunnelId,
      owner_node_id: input.nodeId,
      epoch: current.epoch,
      lease_expires_at: current.lease_expires_at,
    },
    data: { lease_expires_at: input.now, revision: current.revision },
  });
  return released.count === 1
    ? { ok: true }
    : { ok: false, reason: "lost_race" };
}
