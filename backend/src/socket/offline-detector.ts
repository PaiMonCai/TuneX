/**
 * 离线检测 —— 消费 Redis `dc:*` 标记，60s 防抖后将节点置 `inactive`
 *
 * ── 背景 ──
 * `socket/index.ts` 的 `disconnect` handler 已能写离线标记
 * `dc:<groupId>:<nodeId>`（值 = 断开时刻的毫秒时间戳），但**一直没有消费端**：
 * 节点崩溃/失联后 `node.status` 永远停在 `active`，导致 `online_node_count`、
 * 隧道 online 标记、`config-generator` 的 `status=active` 过滤全部失真
 * （见 reports/multi-node-verification.md §7 缺陷#1、tunex-technical-analysis.md §4.7）。
 *
 * 本模块补上消费端，形成完整闭环：
 *
 *   1. 节点断开 → `disconnect` 写 `dc:<gid>:<nodeId>`（TTL = 防抖窗口 + 宽限期）
 *   2. 节点在防抖窗口内重连 → `register` / `sysinfo` **删除**该标记（取消待处理离线）
 *   3. worker 定时调用 {@link runOfflineCheck}：
 *        扫描 `dc:*` → 逐条判定 → 防抖到点且无心跳 → `node.status=inactive`
 *
 * ── 60s 防抖 ──
 * 判定「离线」必须同时满足：
 *   · 距离标记写入已过 `DISCONNECT_DEBOUNCE_MS`（60s）；
 *   · `sysinfo:<gid>:<node_id>` 心跳 key 已不存在（socket 断开后心跳自然停发）。
 * 任一条不满足都跳过：说明节点要么还在防抖窗口内、要么已经重新心跳。
 *
 * ── 为什么标记 TTL 要比防抖窗口长 ──
 * 若标记 TTL == 防抖窗口（60s），而 worker 每 30s 才扫一次，就存在
 * 「标记恰好在两次扫描之间过期」的窗口 → 漏判，节点永久 active。因此标记
 * TTL = 60s + 120s 宽限（{@link DISCONNECT_MARKER_TTL_S}），保证防抖到点后
 * worker 至少能观测到一次。标记的「已到期」由值里的时间戳判定，不由 TTL 判定。
 *
 * ── 幂等 / 容错 ──
 * · `flip` 用 `updateMany(where status=active)` → 重复消费不会重写 updated_at；
 * · 单条标记处理异常被吞掉并计入 `errors`，不阻断整轮扫描；
 * · 扫描用 `SCAN` 游标，不阻塞 Redis。
 *
 * 纯判定逻辑（{@link decideOffline}）与副作用通过 {@link OfflineCheckDeps}
 * 分离，可在无 Redis/DB 环境下单测（本模块顶层不 import db/redis，见
 * {@link defaultOfflineDeps} 的懒加载）。
 */

/** 离线标记 key 前缀：`dc:<groupId>:<nodeId>`。 */
export const DISCONNECT_MARKER_PREFIX = "dc:";
/** 心跳 key 前缀：`sysinfo:<groupId>:<nodeId>`（写端见 socket/index.ts sysinfo）。 */
export const SYSINFO_KEY_PREFIX = "sysinfo:";
/** 活跃节点组集合（sysinfo 时 sadd，本模块在组内无 active 节点时 srem）。 */
export const ALIVE_GROUPS_KEY = "alive_groups";

/** 防抖窗口：断开后 60s 内重连视为未离线。 */
export const DISCONNECT_DEBOUNCE_MS = 60_000;
/** 标记额外的宽限期（秒）：保证 worker 在防抖到点后至少能观测到一次标记。 */
export const DISCONNECT_MARKER_GRACE_S = 120;
/** 标记 TTL = 防抖窗口 + 宽限期 = 180s。 */
export const DISCONNECT_MARKER_TTL_S =
  DISCONNECT_DEBOUNCE_MS / 1000 + DISCONNECT_MARKER_GRACE_S;

/** 离线标记 key。 */
export function disconnectMarkerKey(groupId: number, nodeId: string): string {
  return `${DISCONNECT_MARKER_PREFIX}${groupId}:${nodeId}`;
}

/** 心跳 key（与 socket/index.ts 写端口径一致）。 */
export function sysinfoKey(groupId: number, nodeId: string): string {
  return `${SYSINFO_KEY_PREFIX}${groupId}:${nodeId}`;
}

/** 解析离线标记 key；非 `dc:<int>:<nodeId>` 形态返回 `null`。 */
export function parseDisconnectMarkerKey(
  key: string,
): { groupId: number; nodeId: string } | null {
  const m = /^dc:(\d+):(.+)$/.exec(key);
  if (!m) return null;
  return { groupId: Number(m[1]), nodeId: m[2] };
}

/** 一条离线标记。 */
export interface DisconnectMarker {
  /** Redis key。 */
  key: string;
  groupId: number;
  nodeId: string;
  /** 标记写入时刻（毫秒）；值非法时回退为 0（视为早已到点）。 */
  markedAt: number;
}

/** 从 key/value 解析标记；key 形态不合法返回 `null`。 */
export function parseMarker(key: string, value: string): DisconnectMarker | null {
  const parsed = parseDisconnectMarkerKey(key);
  if (!parsed) return null;
  const n = Number(value);
  return {
    key,
    groupId: parsed.groupId,
    nodeId: parsed.nodeId,
    markedAt: Number.isFinite(n) && n > 0 ? n : 0,
  };
}

/** 判定上下文。 */
export interface OfflineContext {
  /** 当前时刻（毫秒）。 */
  now: number;
  /** 防抖窗口（毫秒）。 */
  debounceMs: number;
  /** 是否仍存在心跳 key（`sysinfo:<gid>:<nodeId>`）。 */
  hasHeartbeat: boolean;
  /** DB 中节点状态；`missing` = 该 node_id 不存在。 */
  nodeStatus: "active" | "inactive" | "missing";
}

/** 判定结论。 */
export type OfflineDecision =
  /** 防抖到点且无心跳 → 应置 inactive。 */
  | "offline"
  /** 仍在防抖窗口内 → 跳过（节点可能正在重连）。 */
  | "within_debounce"
  /** 心跳仍存活 → 跳过（节点已回来，标记是残留）。 */
  | "heartbeat_alive"
  /** DB 已是 inactive → 无需重复写。 */
  | "already_inactive"
  /** DB 无此 node_id → 无可更新对象。 */
  | "node_missing";

/**
 * 纯判定：离线标记 + 上下文 → 结论。
 * 顺序即优先级：节点不存在/防抖未到/心跳存活都会短路，避免误判在线节点。
 */
export function decideOffline(marker: DisconnectMarker, ctx: OfflineContext): OfflineDecision {
  if (ctx.nodeStatus === "missing") return "node_missing";
  if (ctx.now - marker.markedAt < ctx.debounceMs) return "within_debounce";
  if (ctx.hasHeartbeat) return "heartbeat_alive";
  if (ctx.nodeStatus === "inactive") return "already_inactive";
  return "offline";
}

/** 副作用依赖（生产用 {@link defaultOfflineDeps}；测试注入 fake）。 */
export interface OfflineCheckDeps {
  /** 扫描全部离线标记（key + value）。 */
  listMarkers(): Promise<Array<{ key: string; value: string }>>;
  /** 是否仍有心跳。 */
  hasHeartbeat(groupId: number, nodeId: string): Promise<boolean>;
  /** 查询节点状态；不存在返回 `missing`。 */
  getNodeStatus(nodeId: string): Promise<"active" | "inactive" | "missing">;
  /** 置 inactive（仅当当前为 active）；返回是否真正更新。 */
  markInactive(nodeId: string): Promise<boolean>;
  /** 删除标记。 */
  clearMarker(key: string): Promise<void>;
  /** 该组是否仍有 active 节点（用于 alive_groups 清理）。 */
  groupHasActiveNode(groupId: number): Promise<boolean>;
  /** 从 alive_groups 移除该组。 */
  removeAliveGroup(groupId: number): Promise<void>;
  /** 当前毫秒时间戳。 */
  now(): number;
  /** 防抖窗口覆盖；默认 {@link DISCONNECT_DEBOUNCE_MS}。 */
  debounceMs?: number;
  /** 日志。 */
  log?(message: string, meta: Record<string, unknown>): void;
}

/** 一轮扫描的结果统计。 */
export interface OfflineCheckResult {
  /** 解析出的标记总数。 */
  scanned: number;
  /** 本轮置为 inactive 的节点数。 */
  flipped: number;
  skippedWithinDebounce: number;
  skippedHeartbeatAlive: number;
  alreadyInactive: number;
  nodeMissing: number;
  /** 因组内已无 active 节点而从 alive_groups 移除的组 id。 */
  clearedGroups: number[];
  /** 处理失败的标记数（异常已吞，仅计数）。 */
  errors: number;
}

/** 生产依赖：真实 Redis + Prisma（懒加载，避免本模块被单测引入时即连库/校验 env）。 */
export function defaultOfflineDeps(): OfflineCheckDeps {
  return {
    async listMarkers() {
      const { redis } = await import("../redis.ts");
      const out: Array<{ key: string; value: string }> = [];
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          `${DISCONNECT_MARKER_PREFIX}*`,
          "COUNT",
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          const values = await redis.mget(...keys);
          keys.forEach((k, i) => out.push({ key: k, value: values[i] ?? "" }));
        }
      } while (cursor !== "0");
      return out;
    },
    async hasHeartbeat(groupId, nodeId) {
      const { redis } = await import("../redis.ts");
      return (await redis.exists(sysinfoKey(groupId, nodeId))) === 1;
    },
    async getNodeStatus(nodeId) {
      const { db } = await import("../db.ts");
      const row = await db.node.findUnique({
        where: { node_id: nodeId },
        select: { status: true },
      });
      return row ? row.status : "missing";
    },
    async markInactive(nodeId) {
      const { db } = await import("../db.ts");
      // 仅翻转仍为 active 的行：重复消费不重写 updated_at，返回天然幂等。
      const r = await db.node.updateMany({
        where: { node_id: nodeId, status: "active" },
        data: { status: "inactive" },
      });
      return r.count > 0;
    },
    async clearMarker(key) {
      const { redis } = await import("../redis.ts");
      await redis.del(key);
    },
    async groupHasActiveNode(groupId) {
      const { db } = await import("../db.ts");
      const c = await db.node.count({ where: { node_group_id: groupId, status: "active" } });
      return c > 0;
    },
    async removeAliveGroup(groupId) {
      const { redis } = await import("../redis.ts");
      await redis.srem(ALIVE_GROUPS_KEY, String(groupId));
    },
    now: () => Date.now(),
    log: (message, meta) => console.warn(message, meta),
  };
}

/**
 * 消费全部离线标记：防抖到点且无心跳 → 置 inactive，并按需清理 alive_groups。
 *
 * 单条失败不阻断整轮；返回统计供日志/监控。
 */
export async function runOfflineCheck(deps: OfflineCheckDeps): Promise<OfflineCheckResult> {
  const log = deps.log ?? (() => {});
  const debounceMs = deps.debounceMs ?? DISCONNECT_DEBOUNCE_MS;
  const now = deps.now();

  const result: OfflineCheckResult = {
    scanned: 0,
    flipped: 0,
    skippedWithinDebounce: 0,
    skippedHeartbeatAlive: 0,
    alreadyInactive: 0,
    nodeMissing: 0,
    clearedGroups: [],
    errors: 0,
  };

  const markers = await deps.listMarkers();
  const groupsToReap = new Set<number>();

  for (const raw of markers) {
    const marker = parseMarker(raw.key, raw.value);
    if (!marker) continue; // 形态不合法，忽略
    result.scanned++;

    try {
      const [hasHeartbeat, nodeStatus] = await Promise.all([
        deps.hasHeartbeat(marker.groupId, marker.nodeId),
        deps.getNodeStatus(marker.nodeId),
      ]);
      const decision = decideOffline(marker, { now, debounceMs, hasHeartbeat, nodeStatus });

      switch (decision) {
        case "within_debounce":
          // 仍在防抖窗口内：保留标记，等下一轮（节点可能正在重连）。
          result.skippedWithinDebounce++;
          continue;
        case "heartbeat_alive":
          // 心跳仍在：节点活着，标记是残留，清掉。
          result.skippedHeartbeatAlive++;
          await deps.clearMarker(marker.key);
          continue;
        case "node_missing":
          result.nodeMissing++;
          await deps.clearMarker(marker.key);
          continue;
        case "already_inactive":
          result.alreadyInactive++;
          await deps.clearMarker(marker.key);
          continue;
        case "offline": {
          const flipped = await deps.markInactive(marker.nodeId);
          if (flipped) {
            result.flipped++;
            groupsToReap.add(marker.groupId);
            log("[offline] node marked inactive", {
              node_id: marker.nodeId,
              group_id: marker.groupId,
              offline_for_ms: now - marker.markedAt,
            });
          } else {
            result.alreadyInactive++;
          }
          await deps.clearMarker(marker.key);
          continue;
        }
      }
    } catch (e) {
      result.errors++;
      log("[offline] failed to process marker", {
        key: raw.key,
        err: (e as Error)?.message,
      });
    }
  }

  // alive_groups 清理：组内再无 active 节点 → 从活跃集合移除。
  for (const gid of groupsToReap) {
    try {
      if (!(await deps.groupHasActiveNode(gid))) {
        await deps.removeAliveGroup(gid);
        result.clearedGroups.push(gid);
      }
    } catch (e) {
      result.errors++;
      log("[offline] failed to reap alive group", {
        group_id: gid,
        err: (e as Error)?.message,
      });
    }
  }

  return result;
}
