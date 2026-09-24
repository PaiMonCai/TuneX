/**
 * 节点配置刷新 hook（事件 → 受影响节点组 → 推送）
 *
 * `config-pusher.ts#pushNodeConfig(groupId)` 只负责**单个**节点组的
 * 「生成明文配置 → Fernet 加密 → `io.to('node_group/<id>').emit('config', …)`」。
 * 本模块补上「事件 → 受影响节点组集合」这一层，供管理端在以下变更后调用，
 * 使在线节点立即拿到新的 gost 配置（无需等 5s 的 `cron_push_node_config`）：
 *
 *   · 用户停用 / 删除        → 该用户名下隧道的入/出/链路节点组配置需重算
 *   · 套餐停用 / 删除        → 订阅该套餐的全部用户的节点组配置需重算
 *   · 套餐-节点组绑定变更    → 受影响用户隧道所在组 + 绑定前后涉及的组
 *
 * ── 为什么「用户/套餐」变更会影响节点组配置 ──
 * `config-generator.ts#loadAvailableTunnels` 只下发「有效」隧道：
 *   tunnel.status=active ∧ user.status=active ∧ 套餐未过期；
 * `filterAvailableTunnels` 再用 `plan.all_in_node_groups` / `plan.node_groups`
 * 决定某条隧道能否进入某个**入口/出口**节点组的配置。因此一旦：
 *   · 用户被停用 → 其全部隧道从所有相关组配置中消失；
 *   · 套餐绑定的节点组集合变化 → 相关隧道在某些组的「进/出」资格变化；
 * 这些组的配置字节就会变化，必须重推，否则 agent 上仍残留旧的监听/链路。
 *
 * ── 受影响节点组的判定（保守超集，宁多推不漏推）──
 * 对给定的一组用户，取其名下**全部隧道**引用到的节点组：
 *   · `tunnel.in_node_group_id`（入口）
 *   · `tunnel.out_node_group_id`（出口）
 *   · `tunnel_chain.node_group_id`（多跳中间组）
 * 绑定变更场景再并入「变更前绑定」与「变更后绑定」的组 id。
 * 多推不会产生错误配置：`pushNodeConfig` 对同内容重复推送是幂等的，
 * 且原版/agent 对「配置未变」的重复下发可安全忽略。
 *
 * ── 失败策略 ──
 * 本模块的所有入口都是「尽力而为」的后台副作用：查询/推送异常一律**吞掉**
 * （不冒泡到路由，避免影响主业务成功响应）。数据源查询失败退化为空集合。
 */
import { db } from "../db.ts";
import { pushNodeConfig } from "./config-pusher.ts";

/* ------------------------------------------------------------------ */
/* 依赖注入（默认真实实现；测试注入 fake 以便离线运行）                 */
/* ------------------------------------------------------------------ */

export interface ConfigRefreshDataSource {
  /** 给定用户 id 集合 → 其名下隧道直接引用的节点组 id（入/出/链路）。 */
  nodeGroupIdsForUsers(userIds: number[]): Promise<number[]>;
  /** 给定套餐 id 集合 → 订阅这些套餐的用户 id 集合。 */
  userIdsForPlans(planIds: number[]): Promise<number[]>;
  /**
   * 用户**删除**场景的受影响节点组：除其名下隧道引用的组外，还要并入
   * 「该用户拥有的节点组（将被级联删除）」以及「引用了这些组的其他用户隧道
   * 所在的入/出/链路组」——否则删除后别的用户隧道配置仍指向已消失的组。
   */
  nodeGroupIdsForUserDeletion(userIds: number[]): Promise<number[]>;
}

export interface ConfigRefreshDeps {
  dataSource?: ConfigRefreshDataSource;
  /**
   * 推送函数（默认 {@link pushNodeConfig}）。
   * 返回 `false` 表示本次因指纹去重被跳过；`true`/`void` 视为已下发。
   */
  pusher?: (groupId: number) => Promise<boolean | void>;
}

const defaultDataSource: ConfigRefreshDataSource = {
  async nodeGroupIdsForUsers(userIds) {
    if (userIds.length === 0) return [];
    const ids = new Set<number>();
    const [tunnels, chains] = await Promise.all([
      db.tunnel.findMany({
        where: { user_id: { in: userIds } },
        select: { in_node_group_id: true, out_node_group_id: true },
      }),
      db.tunnelChain.findMany({
        where: { tunnel: { user_id: { in: userIds } } },
        select: { node_group_id: true },
      }),
    ]);
    for (const t of tunnels) {
      if (t.in_node_group_id != null) ids.add(t.in_node_group_id);
      if (t.out_node_group_id != null) ids.add(t.out_node_group_id);
    }
    for (const c of chains) {
      if (c.node_group_id != null) ids.add(c.node_group_id);
    }
    return [...ids];
  },

  async userIdsForPlans(planIds) {
    if (planIds.length === 0) return [];
    const rows = await db.userPlan.findMany({
      where: { plan_id: { in: planIds } },
      select: { user_id: true },
    });
    return [...new Set(rows.map((r) => r.user_id))];
  },

  async nodeGroupIdsForUserDeletion(userIds) {
    if (userIds.length === 0) return [];
    const ids = new Set<number>();
    // ① 该用户名下隧道直接引用的组
    for (const id of await this.nodeGroupIdsForUsers(userIds)) ids.add(id);
    // ② 该用户拥有的节点组（将被级联删除）
    const owned = await db.nodeGroup.findMany({
      where: { user_id: { in: userIds } },
      select: { id: true },
    });
    const ownedIds = owned.map((g) => g.id);
    for (const id of ownedIds) ids.add(id);
    if (ownedIds.length === 0) return [...ids];
    // ③ 引用了这些组的其他用户隧道所在的入/出/链路组
    const [refTunnels, refChains] = await Promise.all([
      db.tunnel.findMany({
        where: {
          OR: [{ in_node_group_id: { in: ownedIds } }, { out_node_group_id: { in: ownedIds } }],
        },
        select: { in_node_group_id: true, out_node_group_id: true },
      }),
      db.tunnelChain.findMany({
        where: { node_group_id: { in: ownedIds } },
        select: { tunnel: { select: { in_node_group_id: true, out_node_group_id: true } } },
      }),
    ]);
    for (const t of refTunnels) {
      if (t.in_node_group_id != null) ids.add(t.in_node_group_id);
      if (t.out_node_group_id != null) ids.add(t.out_node_group_id);
    }
    for (const c of refChains) {
      if (c.tunnel.in_node_group_id != null) ids.add(c.tunnel.in_node_group_id);
      if (c.tunnel.out_node_group_id != null) ids.add(c.tunnel.out_node_group_id);
    }
    return [...ids];
  },
};

/* ------------------------------------------------------------------ */
/* 纯逻辑：去重 / 过滤非法 id                                          */
/* ------------------------------------------------------------------ */

/** 去重 + 丢弃非正整数（防御 NaN / undefined / 0）。 */
export function normalizeGroupIds(ids: Iterable<number | null | undefined>): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === "number" && Number.isInteger(id) && id > 0) out.add(id);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* 受影响节点组集合：计算                                                 */
/* ------------------------------------------------------------------ */

/** 计算「给定用户集合」变更时受影响的节点组 id 集合（不含刷新）。 */
export async function collectAffectedNodeGroupsForUsers(
  userIds: Iterable<number>,
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const ids = normalizeGroupIds(userIds);
  if (ids.length === 0) return [];
  const ds = deps.dataSource ?? defaultDataSource;
  try {
    return normalizeGroupIds(await ds.nodeGroupIdsForUsers(ids));
  } catch {
    return [];
  }
}

/** 计算「用户被删除」时受影响的节点组 id 集合（含其拥有组 + 引用这些组的其他隧道组）。 */
export async function collectAffectedNodeGroupsForUserDeletion(
  userIds: Iterable<number>,
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const ids = normalizeGroupIds(userIds);
  if (ids.length === 0) return [];
  const ds = deps.dataSource ?? defaultDataSource;
  try {
    return normalizeGroupIds(await ds.nodeGroupIdsForUserDeletion(ids));
  } catch {
    return [];
  }
}

/**
 * 计算「给定套餐集合」变更时受影响的节点组 id 集合（不含刷新）。
 * `extraGroupIds` 用于并入绑定变更场景的「变更前/后」绑定组。
 */
export async function collectAffectedNodeGroupsForPlans(
  planIds: Iterable<number>,
  extraGroupIds: Iterable<number> = [],
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const ids = normalizeGroupIds(planIds);
  const ds = deps.dataSource ?? defaultDataSource;
  let userIds: number[] = [];
  try {
    userIds = ids.length === 0 ? [] : normalizeGroupIds(await ds.userIdsForPlans(ids));
  } catch {
    userIds = [];
  }
  const fromUsers = await collectAffectedNodeGroupsForUsers(userIds, deps);
  return normalizeGroupIds([...fromUsers, ...extraGroupIds]);
}

/* ------------------------------------------------------------------ */
/* 刷新（推送）                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把给定节点组集合的配置重新生成并推送给各自 room 内的在线 agent。
 * 逐组独立、异常吞掉。
 *
 * @returns **实际发生下发**的组 id 列表（去重命中而被跳过的组不计入）。
 */
export async function refreshNodeGroups(
  groupIds: Iterable<number | null | undefined>,
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const ids = normalizeGroupIds(groupIds);
  if (ids.length === 0) return [];
  const push = deps.pusher ?? pushNodeConfig;
  const pushed: number[] = [];
  for (const id of ids) {
    try {
      const didPush = await push(id);
      if (didPush) pushed.push(id);
    } catch {
      /* 单组失败不影响其余 */
    }
  }
  return pushed;
}

/* ------------------------------------------------------------------ */
/* 高层入口：按事件直接刷新（供路由调用）                               */
/* ------------------------------------------------------------------ */

/** 用户停用/删除后刷新：返回被刷新的节点组列表。 */
export async function refreshNodeGroupsForUsers(
  userIds: Iterable<number>,
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const groups = await collectAffectedNodeGroupsForUsers(userIds, deps);
  return refreshNodeGroups(groups, deps);
}

/** 套餐停用/删除后刷新（可并入额外的绑定组 id）：返回被刷新的节点组列表。 */
export async function refreshNodeGroupsForPlans(
  planIds: Iterable<number>,
  extraGroupIds: Iterable<number> = [],
  deps: ConfigRefreshDeps = {},
): Promise<number[]> {
  const groups = await collectAffectedNodeGroupsForPlans(planIds, extraGroupIds, deps);
  return refreshNodeGroups(groups, deps);
}

/**
 * fire-and-forget 包装：路由层统一用 `void enqueueXxx(...)` 调用，
 * 保证任何异常都不会冒泡到主业务响应。
 */
export function enqueueRefresh(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}
