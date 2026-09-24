/**
 * 节点配置推送 — Fernet 加密 + Socket.IO 下发 + 增量去重
 *
 * 协议事实（与原版一致）：
 *   - config 下发格式: 42["config","<fernet>"]——裸字符串，不是数组
 *   - 推送到 room `node_group/${groupId}`
 *
 * ── 增量去重（与原版一致）──
 * 原版 `TunnelService.pushNodeConfig` 用 Redis `node_group:config_hash`（hash，
 * field=groupId）记录上次下发的**明文 JSON 的 sha256**（`config-generator` 已产出
 * `fingerprint`），仅当指纹变化时才 emit。
 *
 * 本模块的语义：
 *   · 默认路径（不传 `force`）：指纹与缓存一致 → 直接跳过 `emit`，**不加密、不下发**；
 *     指纹变化或缓存缺失 → 下发并把新指纹写入缓存。
 *   · `force: true`：跳过比对强制下发（节点 register 上线首推必须拿到配置），
 *     但**仍会把当前指纹写入缓存**，保证后续非强制调用能正确去重。
 *
 * 为什么必须保留 force：去重基于「内容指纹」，无法区分「同一份配置推给首次连上的
 * 新节点」——若 register 也走默认去重，重连节点在配置未变时将永远收不到配置。
 *
 * ── fail-open ──
 * Redis 不可用时**一律放行**（`shouldPush` 视为变化、`markConfigPushed` 静默失败），
 * 配置可达性优先于省流：宁可能重复推送，也不能因缓存故障让节点拿不到配置。
 *
 * ── TEN-02：作用域 ──
 *   1. 指纹缓存键按 scope 分隔（{@link configHashKey}）：
 *      `ws:<scope>:node_group:config_hash`，field 仍是 groupId；否则两个租户的
 *      同 ID 组会撞同一 hash 而互相覆盖指纹（旧版裸名 `node_group:config_hash`
 *      正是如此）。
 *   2. 下发 room 由 `socketRoom(scope, groupId)` 派生，**连接方无法自选 room**：
 *      只有真正持有该组 token（且该组属其 scope）的 agent 才会收到。
 */
import { generateNodeConfig } from "./config-generator.ts";
import { fernetEncryptWith } from "../services/license-sign.ts";
import { redis } from "../redis.ts";
import { configKey } from "../crypto/keys.ts";
import {
  GLOBAL_SCOPE,
  configHashKey,
  scopeId,
  socketRoom,
} from "../tenant-scope.ts";

/* 键工具从 tenant-scope 统一导出（保持既有 import 路径可用）。 */
export { configHashKey, socketRoom, scopeId, GLOBAL_SCOPE };

/** 指纹缓存基名（无 scope 前缀，仅供文档/旧键引用）。 */
export const NODE_GROUP_CONFIG_HASH_KEY = "node_group:config_hash";

export interface PushNodeConfigOptions {
  /** 跳过去重，强制下发（节点 register / 上线首推时使用）。 */
  force?: boolean;
  /**
   * 显式指定作用域（= 节点组所属 workspace id；平台组为 0）。
   * 不传则由 {@link resolveGroupScope} 从 DB 解析。
   */
  scope?: number;
}

/* ------------------------------------------------------------------ */
/* 节点组 → 作用域 解析（可注入，便于离线单测）                        */
/* ------------------------------------------------------------------ */

export type GroupScopeResolver = (groupId: number) => Promise<number>;

const defaultResolveGroupScope: GroupScopeResolver = async (groupId) => {
  // 懒加载 Prisma，避免本模块被单测引入时即连库。
  const { db } = await import("../db.ts");
  const g = await db.nodeGroup.findUnique({
    where: { id: groupId },
    select: { workspace_id: true },
  });
  if (!g) return GLOBAL_SCOPE;
  return scopeId(g.workspace_id);
};

let groupScopeResolver: GroupScopeResolver = defaultResolveGroupScope;

/** 注入/重置作用域解析器（测试用；传 null 恢复默认 DB 解析）。 */
export function setGroupScopeResolver(fn: GroupScopeResolver | null): void {
  groupScopeResolver = fn ?? defaultResolveGroupScope;
}

/**
 * 解析节点组作用域：其 `workspace_id`（无归属亦折叠为 0）。
 * 解析异常时保守回退 0（宁可推到平台 room，也不跨租户错投）。
 */
export async function resolveGroupScope(groupId: number): Promise<number> {
  try {
    return scopeId(await groupScopeResolver(groupId));
  } catch {
    return GLOBAL_SCOPE;
  }
}

/* ------------------------------------------------------------------ */
/* 指纹缓存（按 scope）                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取某节点组上次下发的指纹；缓存缺失/不可用返回 null。
 * （Redis 故障时也返回 null，等价于「未推送过」——调用方按需 fail-open。）
 */
export async function getPushedFingerprint(
  groupId: number,
  scope: number | null | undefined = GLOBAL_SCOPE,
): Promise<string | null> {
  try {
    return await redis.hget(configHashKey(scope), String(groupId));
  } catch {
    return null;
  }
}

/**
 * 记录某节点组本次下发的指纹。写失败只打日志、不抛出（fail-open）。
 * @returns 是否写入成功。
 */
export async function markConfigPushed(
  groupId: number,
  fingerprint: string,
  scope: number | null | undefined = GLOBAL_SCOPE,
): Promise<boolean> {
  try {
    await redis.hset(configHashKey(scope), String(groupId), fingerprint);
    return true;
  } catch (e) {
    console.warn(
      `[config-push] failed to record fingerprint for group ${groupId} (scope ${scopeId(scope)}):`,
      (e as Error)?.message ?? e,
    );
    return false;
  }
}

/** 清除某节点组的指纹缓存（节点组删除/重置时使用）。 */
export async function clearConfigFingerprint(
  groupId: number,
  scope: number | null | undefined = GLOBAL_SCOPE,
): Promise<void> {
  try {
    await redis.hdel(configHashKey(scope), String(groupId));
  } catch {
    /* 忽略缓存删除失败 */
  }
}

/**
 * 是否应下发：指纹变化（含缓存缺失）→ true。
 * Redis 不可用 fail-open：视为变化，强制推送。
 */
async function shouldPush(
  groupId: number,
  fingerprint: string,
  scope: number,
): Promise<boolean> {
  try {
    const old = await redis.hget(configHashKey(scope), String(groupId));
    return old !== fingerprint;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 下发                                                               */
/* ------------------------------------------------------------------ */

/**
 * 推送配置到指定节点组的所有节点（room 按 scope 隔离）。
 * 如果 Socket.IO 未初始化，静默返回 false。
 *
 * @returns 实际是否发生了下发（默认路径上去重命中时为 false）。
 */
export async function pushNodeConfig(
  groupId: number,
  options: PushNodeConfigOptions = {},
): Promise<boolean> {
  const io = (globalThis as Record<string, unknown>).__io as
    | { to: (room: string) => { emit: (event: string, ...args: unknown[]) => void } }
    | undefined;
  if (!io) return false;

  const scope = options.scope !== undefined ? scopeId(options.scope) : await resolveGroupScope(groupId);

  const config = await generateNodeConfig(groupId);
  // config 是 GeneratedNodeConfig{nodeGroupId,nodeType,config,json,fingerprint}；
  // 下发的是其中的 json 字段（gost 配置本体），指纹是明文 JSON 的 sha256。

  // 增量去重：默认路径下指纹未变则跳过（不加密、不下发）。
  if (!options.force) {
    const changed = await shouldPush(groupId, config.fingerprint, scope);
    if (!changed) return false;
  }

  const encrypted = fernetEncryptWith(configKey(), config.json);
  // TEN-02：room 名带 scope，只有同 scope 的 agent 会收到。
  io.to(socketRoom(scope, groupId)).emit("config", encrypted);

  // 记录指纹（供下次去重）；force 路径同样落缓存，写失败不阻断下发。
  await markConfigPushed(groupId, config.fingerprint, scope);
  return true;
}
